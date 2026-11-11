import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { BackLink, Badge, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, ListCard, ListRow, LoadMore, PageHeader, Panel, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useFilters, usePagedList, useRefresh } from '../../lib/query.js';
import { CATALOG_TABS } from '../catalog/form.js';
import { CATALOG, CSV_COLUMNS, CSV_TYPES } from '../catalog/shared/limits.js';
import { AreaTabs, PlanState, Screen, isPlanRefusal } from '../catalog/shared/ui.jsx';
import { DraftReview } from './DraftReview.jsx';
import { WAYS, bulkBody, csvProblem, isRunning, jobLine, jobState, kindText, linkBody, linkResultView, shopifyBody } from './form.js';

/** Runs one of the import calls, holding what it answered or why it was refused. */
function useImport() {
  const [state, setState] = useState({ busy: false, error: null, fieldError: '' });
  async function run(check, call) {
    const { body, error } = check();
    if (error) return setState({ busy: false, error: null, fieldError: error });
    setState({ busy: true, error: null, fieldError: '' });
    try {
      const answer = await call(body);
      setState({ busy: false, error: null, fieldError: '' });
      return answer;
    } catch (failure) {
      setState({ busy: false, error: failure, fieldError: Object.values(failure.fields ?? {})[0] ?? '' });
      return null;
    }
  }
  return { ...state, run };
}

function Refusal({ error }) {
  if (!error) return null;
  if (isPlanRefusal(error)) return <PlanState error={error} />;
  return <Banner tone="bad">{error.message}</Banner>;
}

/** One link: read now, and answered with a draft to check, the product it already is, or why it couldn't be imported (8.3, 8.7). */
function OneLink() {
  const navigate = useNavigate();
  const importer = useImport();
  const [url, setUrl] = useState('');
  const [result, setResult] = useState(null);
  const [reviewing, setReviewing] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setResult(null);
    setReviewing(false);
    const answer = await importer.run(() => linkBody(url), (body) => api.imports.link(body));
    if (!answer) return;
    setResult(answer);
    setReviewing(answer.status === 'draft' && Boolean(answer.itemId));
  }

  const view = result && linkResultView(result);
  return (
    <>
      <form className="stack" onSubmit={submit} noValidate>
        <Panel title="Paste a product link">
          <p className="muted">The address of one product’s page on your website. We read its name, price and photos; nothing is saved until you check it.</p>
          <FieldGroup>
            <TextField label="Product link" type="url" inputMode="url" placeholder="https://yourstore.com/products/…" value={url} error={importer.fieldError} onChange={(event) => setUrl(event.target.value)} />
          </FieldGroup>
          <Button type="submit" loading={importer.busy}>{importer.busy ? 'Reading the page…' : 'Read this page'}</Button>
        </Panel>
      </form>
      <Refusal error={importer.error} />
      {view && (
        <Panel title={view.title} aria-live="polite">
          {view.text && <Banner tone={view.tone}>{view.text}</Banner>}
          {view.productId && <Button as={Link} variant="soft" to={`/catalog/${view.productId}`}>Open the product</Button>}
          {view.review && !reviewing && <Button variant="soft" onClick={() => setReviewing(true)}>Check what we read</Button>}
          {view.manual && !reviewing && <Button as={Link} variant="outline" to="/catalog/new" state={{ draft: result.draft ?? { externalUrl: url.trim() } }}>Add the details yourself</Button>}
        </Panel>
      )}
      {reviewing && (
        <DraftReview
          key={result.itemId}
          itemId={result.itemId}
          draft={result.draft}
          note={result.status === 'refused' ? 'Fill in what is missing. Saving it is your decision, so the quality check doesn’t stop you.' : ''}
          onSaved={(productId) => navigate(`/catalog/${productId}`)}
          onCancel={() => setReviewing(false)}
        />
      )}
    </>
  );
}

function ManyLinks({ onStarted }) {
  const importer = useImport();
  const [text, setText] = useState('');
  async function submit(event) {
    event.preventDefault();
    const job = await importer.run(() => bulkBody(text), (body) => api.imports.bulk(body));
    if (job) onStarted(job);
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Panel title="Paste product links">
        <p className="muted">One link per line, up to {CATALOG.bulkLinks} at a time. We read them in the background and list what happened to each.</p>
        <FieldGroup>
          <TextAreaField label="Product links" rows={6} placeholder={'https://yourstore.com/products/one\nhttps://yourstore.com/products/two'} value={text} error={importer.fieldError} onChange={(event) => setText(event.target.value)} />
        </FieldGroup>
        <Button type="submit" loading={importer.busy}>Import these links</Button>
      </Panel>
      <Refusal error={importer.error} />
    </form>
  );
}

function ShopifyStore({ onStarted }) {
  const importer = useImport();
  const [storeUrl, setStoreUrl] = useState('');
  async function submit(event) {
    event.preventDefault();
    const job = await importer.run(() => shopifyBody(storeUrl), (body) => api.imports.shopify(body));
    if (job) onStarted(job);
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Panel title="Import a Shopify store">
        <p className="muted">We read your store’s public product list: every product, with its variants, prices and photos. Importing again later updates prices and stock, and keeps the changes you made here.</p>
        <FieldGroup>
          <TextField label="Store address" inputMode="url" placeholder="yourstore.com" value={storeUrl} error={importer.fieldError} onChange={(event) => setStoreUrl(event.target.value)} />
        </FieldGroup>
        <Button type="submit" loading={importer.busy}>Import this store</Button>
      </Panel>
      <Refusal error={importer.error} />
    </form>
  );
}

function CsvFile({ onStarted }) {
  const importer = useImport();
  const [file, setFile] = useState(null);
  async function submit(event) {
    event.preventDefault();
    const job = await importer.run(() => (csvProblem(file) ? { error: csvProblem(file) } : { body: file }), (chosen) => api.imports.csv(chosen));
    if (job) onStarted(job);
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Panel title="Upload a CSV file">
        <p className="muted">Up to {CATALOG.csvRows.toLocaleString('en-IN')} rows and 2 MB, saved as UTF-8. The first line names the columns:</p>
        <p className="p3-code">{CSV_COLUMNS.join(', ')}</p>
        <p className="field-hint">Only title, url and price are needed. A row whose url is already in your catalog updates that product.</p>
        <label className="btn btn-soft file-button">
          <Upload size={16} strokeWidth={1.8} aria-hidden="true" />
          {file ? 'Choose another file' : 'Choose a file'}
          <input className="sr-only" type="file" accept={CSV_TYPES.join(',')} onChange={(event) => setFile(event.target.files[0] ?? null)} />
        </label>
        {file && <p className="field-hint" role="status">{file.name}</p>}
        {importer.fieldError && <p className="field-error" role="alert">{importer.fieldError}</p>}
        <Button type="submit" loading={importer.busy} disabled={!file}>Import this file</Button>
      </Panel>
      <Refusal error={importer.error && !importer.fieldError ? importer.error : null} />
    </form>
  );
}

function JobRow({ job }) {
  const state = jobState(job);
  return (
    <ListRow
      as={Link}
      to={`/imports/${job.id}`}
      title={`${kindText(job.kind)}${job.source ? `: ${job.source}` : ''}`}
      meta={`${jobLine(job)} · ${formatDateTime(job.createdAt)}`}
      trailing={<Badge tone={state.tone}>{state.text}</Badge>}
    />
  );
}

function RecentImports() {
  const jobs = usePagedList('imports', api.imports.list, {}, {
    // An import in progress is re-read until it finishes, so the counts move without a reload.
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.items.some(isRunning)) ? 3000 : false),
  });
  return (
    <Panel title="Recent imports">
      <Screen query={jobs} label="Loading your imports" errorTitle="We couldn’t load your imports">
        {() => (jobs.items.length ? (
          <>
            <ListCard aria-label="Recent imports">{jobs.items.map((job) => <JobRow key={job.id} job={job} />)}</ListCard>
            <LoadMore query={jobs} />
          </>
        ) : <EmptyState title="No imports yet">Each import is listed here with what happened to every product.</EmptyState>)}
      </Screen>
    </Panel>
  );
}

/** Which import adapters our team has switched on for this business (8.4): said plainly, so the owner knows links use them. */
function AdapterNote() {
  const adapters = useQuery({ queryKey: ['imports', 'adapters'], queryFn: () => api.imports.adapters() });
  const enabled = adapters.data?.items.filter((adapter) => adapter.enabled) ?? [];
  if (!enabled.length) return null;
  return <Banner tone="info">Links from {enabled.map((adapter) => adapter.label).join(', ')} are read through your site’s own product service, so they come in complete.</Banner>;
}

export default function ImportPage() {
  const navigate = useNavigate();
  const refresh = useRefresh();
  const [params, setFilter] = useFilters();
  const way = WAYS.some(([key]) => key === params.get('way')) ? params.get('way') : 'link';
  const started = async (job) => {
    await refresh();
    navigate(`/imports/${job.id}`);
  };

  return (
    <>
      <BackLink to="/catalog">Catalog</BackLink>
      <PageHeader title="Import products" />
      <AreaTabs label="Catalog pages" tabs={CATALOG_TABS} current="/imports" />
      <AdapterNote />
      <ChipRow label="How to import">
        {WAYS.map(([key, label]) => <Chip key={key} pressed={way === key} onClick={() => setFilter('way', key === 'link' ? '' : key)}>{label}</Chip>)}
      </ChipRow>
      {way === 'link' && <OneLink />}
      {way === 'bulk' && <ManyLinks onStarted={started} />}
      {way === 'shopify' && <ShopifyStore onStarted={started} />}
      {way === 'csv' && <CsvFile onStarted={started} />}
      <RecentImports />
    </>
  );
}
