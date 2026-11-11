import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { BackLink, Badge, Banner, Button, Chip, ChipRow, EmptyState, LoadMore, PageHeader, Panel, Stat } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { Screen } from '../catalog/shared/ui.jsx';
import { DraftReview } from './DraftReview.jsx';
import { ITEM_FILTERS, isRunning, itemView, jobLine, jobState, kindText } from './form.js';

function Item({ item, onReview }) {
  const view = itemView(item);
  return (
    <li className="p3-item">
      <div className="p3-item-head">
        <span className="list-row-title">{view.title}</span>
        <Badge tone={view.tone}>{view.text}</Badge>
      </div>
      {view.where && <span className="list-row-meta p3-break">{view.where}</span>}
      {view.message && <p className="p3-item-message">{view.message}</p>}
      {view.gate && <span className="field-hint">{view.gate}</span>}
      <div className="row-actions">
        {view.productId && <Button as={Link} variant="soft" to={`/catalog/${view.productId}`}>Open the product</Button>}
        {view.canSave && <Button variant="soft" onClick={() => onReview(item)}>{view.action}</Button>}
      </div>
    </li>
  );
}

function Items({ job }) {
  const [params, setFilter] = useFilters();
  const status = ITEM_FILTERS.some(([key]) => key === params.get('status')) ? params.get('status') : 'all';
  const [reviewing, setReviewing] = useState(null);
  const items = usePagedList('import-items', (query) => api.imports.items(job.id, query), { job: job.id, status }, { refetchInterval: isRunning(job) ? 3000 : false });
  // The last items can be written after the final timed fetch, so read the list once more when the job ends.
  const running = isRunning(job);
  const { refetch } = items;
  useEffect(() => {
    if (!running) refetch();
  }, [running, refetch]);

  if (reviewing) {
    return (
      <Panel title={`Check ${reviewing.draft?.name || 'this product'}`}>
        <DraftReview
          key={reviewing.id}
          itemId={reviewing.id}
          draft={reviewing.draft ?? { externalUrl: reviewing.url }}
          note={reviewing.status === 'refused' ? `${reviewing.message} Fill in what is missing; saving it is your decision.` : ''}
          onSaved={() => setReviewing(null)}
          onCancel={() => setReviewing(null)}
        />
      </Panel>
    );
  }

  return (
    <Panel title="What happened to each product">
      <ChipRow label="Filter the products">
        {ITEM_FILTERS.map(([key, label]) => <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key === 'all' ? '' : key)}>{label}</Chip>)}
      </ChipRow>
      <Screen query={items} label="Loading the products" errorTitle="We couldn’t load the products of this import">
        {() => (items.items.length ? (
          <>
            <ul className="p3-items" aria-label="Products in this import">{items.items.map((item) => <Item key={item.id} item={item} onReview={setReviewing} />)}</ul>
            <LoadMore query={items} />
          </>
        ) : (
          <EmptyState title={status === 'all' ? (isRunning(job) ? 'Nothing read yet' : 'Nothing was imported') : 'None like that'}>
            {status === 'all' ? (isRunning(job) ? 'Products appear here as each one is read.' : 'This import found no products.') : 'Pick another filter to see the rest.'}
          </EmptyState>
        ))}
      </Screen>
    </Panel>
  );
}

function Job({ job }) {
  const state = jobState(job);
  return (
    <>
      <PageHeader eyebrow={kindText(job.kind)} title={job.source || 'Import'} actions={<Badge tone={state.tone}>{state.text}</Badge>} />
      <p className="lead" role="status">{jobLine(job)} · Started {formatDateTime(job.createdAt)}{job.finishedAt ? `, finished ${formatDateTime(job.finishedAt)}` : ''}</p>
      {isRunning(job) && <Banner tone="info">Still working. This page updates by itself; you can leave and come back.</Banner>}
      {job.status === 'failed' && <Banner tone="bad">{job.message || 'We couldn’t finish this import.'} Paste product links or upload a CSV file instead.</Banner>}
      {job.status === 'done' && job.message && <Banner tone="warn">{job.message}</Banner>}
      <div className="p3-stats">
        <Stat value={job.total} label="Found" />
        <Stat value={job.created} label="Added" />
        <Stat value={job.updated} label="Updated" />
        <Stat value={job.refused + job.failed} label="Need a look" />
      </div>
      <Items job={job} />
    </>
  );
}

export default function ImportJobPage() {
  const { id } = useParams();
  const job = useQuery({
    queryKey: ['imports', id],
    queryFn: () => api.imports.get(id),
    refetchInterval: (query) => (query.state.data && isRunning(query.state.data) ? 2000 : false),
  });
  return (
    <>
      <BackLink to="/imports">Imports</BackLink>
      <Screen query={job} detail label="Loading this import" errorTitle="We couldn’t load this import">
        {(data) => <Job job={data} />}
      </Screen>
    </>
  );
}
