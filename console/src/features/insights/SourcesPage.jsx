import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Button, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, SelectField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { useAllowed, usePagedList } from '../../lib/query.js';
import { AnalyticsLoadable, InsightsTabs, SourceTag } from './shared/ui.jsx';
import { formatCount, formatDay } from './shared/words.js';

export const DESTINATION_WORDS = Object.freeze({
  ga4: { label: 'Google Analytics 4', detail: 'Visits to your own site that came from a DM link, by its UTM tags.' },
  site_tag: { label: 'Visit tag on your own site', detail: 'A small script on your own site that reports visits from DM links.' },
  shopify: { label: 'Shopify orders', detail: 'Orders on your Shopify store, matched by UTM tags or landing page.' },
  amazon: { label: 'Amazon earnings', detail: 'Earnings per reel by its tracking ID, from a report you upload.' },
  affiliate: { label: 'Affiliate earnings', detail: 'Earnings per reel by its sub-ID, where the network reports them.' },
  discount_code: { label: 'Discount codes', detail: 'Orders that used a reel’s own discount code.' },
});
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CSV_TYPES = ['text/csv', 'application/vnd.ms-excel', 'text/plain', ''];

function Connections({ items }) {
  return (
    <div className="an-rows">
      {items.map((item) => {
        const words = Object.hasOwn(DESTINATION_WORDS, item.source) ? DESTINATION_WORDS[item.source] : { label: item.source, detail: '' };
        return (
          <div key={item.source} className="an-row">
            <span className="an-row-main">
              <span className="an-row-title">{words.label}</span>
              <span className="an-row-meta">{words.detail}</span>
              {item.connectedAt && <span className="an-row-meta">{`Connected ${formatDate(item.connectedAt)}`}</span>}
            </span>
            <Badge tone={item.enabled ? 'good' : 'neutral'}>{item.enabled ? 'On' : 'Off'}</Badge>
          </div>
        );
      })}
    </div>
  );
}

/** The site tag reports visits on the seller's own site. Its code names only the seller's own address. */
function SiteTag({ enabled }) {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const [snippet, setSnippet] = useState('');
  const save = useMutation({
    mutationFn: (on) => api.destinations.setSiteTag({ enabled: on }),
    onSuccess: async (result) => {
      setSnippet(result.snippet);
      toast(result.enabled ? 'The visit tag is on. Add the code to your site.' : 'The visit tag is off.');
      await queries.invalidateQueries({ queryKey: ['destinations'] });
    },
    onError: (error) => toast(error.message),
  });
  return (
    <Panel title="Visits on your own site">
      <p className="muted">With one tap a shopper goes straight to your site, so Bhava can count those visits only if your site reports them, through Google Analytics or this tag.</p>
      <Toggle label="Use the visit tag" checked={enabled} disabled={save.isPending} onChange={(event) => save.mutate(event.target.checked)} />
      {enabled && !snippet && <Button variant="soft" loading={save.isPending} onClick={() => save.mutate(true)}>Show the code</Button>}
      {snippet && (
        <>
          <p className="muted">Paste this just before the closing body tag on every page of your site.</p>
          <code className="an-snippet">{snippet}</code>
          <CopyButton text={snippet} label="Copy the code" />
        </>
      )}
    </Panel>
  );
}

function UploadReport() {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const input = useRef(null);
  const [source, setSource] = useState('amazon');
  const [network, setNetwork] = useState('');
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(null);
  const upload = useMutation({
    mutationFn: (file) => api.destinations.uploadReport(file, { source, network: source === 'affiliate' ? network.trim() : '' }),
    onSuccess: async (row) => {
      setDone(row);
      if (input.current) input.current.value = '';
      await queries.invalidateQueries({ queryKey: ['destination-reports'] });
    },
    onError: (error) => setProblem(error.message),
  });

  function send(event) {
    event.preventDefault();
    setProblem('');
    setDone(null);
    const file = input.current?.files?.[0];
    if (!file) return setProblem('Choose the report file first.');
    if (file.size > MAX_UPLOAD_BYTES) return setProblem('That file is larger than 5 MB.');
    if (!CSV_TYPES.includes(file.type) && file.name.toLowerCase().split('.').pop() !== 'csv') return setProblem('Upload the report as a CSV file.');
    if (source === 'affiliate' && !network.trim()) return setProblem('Name the affiliate network.');
    upload.mutate(file);
    return undefined;
  }

  return (
    <Panel title="Upload an earnings report">
      <p className="muted">Amazon and most affiliate networks don’t share earnings directly. Upload their report and Bhava matches each line to a reel by its tracking ID or sub-ID.</p>
      <form className="an-form" onSubmit={send} noValidate>
        <FieldGroup>
          <SelectField label="From" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="amazon">Amazon Associates</option>
            <option value="affiliate">Another affiliate network</option>
          </SelectField>
          {source === 'affiliate' && <TextField label="Network name" maxLength={40} value={network} onChange={(event) => setNetwork(event.target.value)} />}
        </FieldGroup>
        <label className="file-button btn btn-outline">
          <Upload size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>Choose the CSV file</span>
          <input ref={input} className="sr-only" type="file" accept="text/csv,text/plain,application/vnd.ms-excel" />
        </label>
        {problem && <p className="field-error" role="alert">{problem}</p>}
        {done && <p className="banner banner-good" role="status">{`${formatCount(done.rowsImported)} lines matched${done.rowsUnmatched ? `, ${formatCount(done.rowsUnmatched)} didn’t match a reel` : ''}.`}</p>}
        <Button type="submit" loading={upload.isPending}>Upload report</Button>
      </form>
    </Panel>
  );
}

function Uploads() {
  const uploads = usePagedList('destination-reports', api.destinations.reports);
  return (
    <Panel title="Reports uploaded" action={<SourceTag source="destination" />}>
      <AnalyticsLoadable query={uploads} label="Loading uploaded reports" errorTitle="We couldn’t load uploaded reports">
        {() => (uploads.items.length ? (
          <>
            <div className="an-rows">
              {uploads.items.map((row) => (
                <div key={row.id} className="an-row">
                  <span className="an-row-main">
                    <span className="an-row-title">{row.source === 'amazon' ? 'Amazon Associates' : row.network || 'Affiliate network'}</span>
                    <span className="an-row-meta">{row.periodFrom && row.periodTo ? `${formatDay(row.periodFrom)} to ${formatDay(row.periodTo, { year: true })}` : 'Period not stated in the file'}</span>
                    <span className="an-row-meta">{`Uploaded ${formatDateTime(row.uploadedAt)}`}</span>
                  </span>
                  <span className="an-row-end">
                    <span>{`${formatCount(row.rowsImported)} matched`}</span>
                    {row.rowsUnmatched > 0 && <span className="an-row-meta">{`${formatCount(row.rowsUnmatched)} not matched`}</span>}
                  </span>
                </div>
              ))}
            </div>
            <LoadMore query={uploads} />
          </>
        ) : <EmptyState title="No reports uploaded">Earnings from Amazon and affiliate networks appear in each reel’s funnel once a report is uploaded.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

/** Where sales outside Bhava's own pages come from (7.15): each counts as "From the destination", never as Bhava's. */
export default function SourcesPage() {
  const allowed = useAllowed();
  const canManage = allowed(MANAGERS);
  const connections = useQuery({ queryKey: ['destinations', 'connections'], queryFn: () => api.destinations.connections() });
  return (
    <>
      <PageHeader eyebrow="Insights" title="Sales sources" />
      <InsightsTabs />
      <p className="lead">Visits and sales that happen off your store pages, as your own site and the networks report them.</p>
      <Panel title="Connected" action={<SourceTag source="destination" />}>
        <AnalyticsLoadable query={connections} label="Checking your sales sources" errorTitle="We couldn’t check your sales sources">
          {(data) => (data.items.length ? <Connections items={data.items} /> : <EmptyState title="Nothing connected yet">Turn on the visit tag or upload a report below.</EmptyState>)}
        </AnalyticsLoadable>
      </Panel>
      {canManage && connections.data && <SiteTag enabled={Boolean(connections.data.items.find((i) => i.source === 'site_tag')?.enabled)} />}
      {canManage && <UploadReport />}
      {!canManage && <p className="muted">Only the owner or a manager can change these.</p>}
      <Uploads />
    </>
  );
}
