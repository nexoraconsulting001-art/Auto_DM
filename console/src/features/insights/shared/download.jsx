import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Badge, Button } from '../../../design/index.jsx';
import { api } from '../../../lib/api/index.js';
import { DOWNLOAD_STATUS_WORDS, FORMAT_WORDS, canOpen, downloadBody } from './figures.js';
import { wordFor } from './words.js';

const POLL_MS = 3000;
const FINISHED = new Set(['ready', 'failed', 'expired']);

/** A download being made: asks again every few seconds until it is ready or has failed. */
export function useDownloadStatus(created) {
  const id = created?.id;
  const query = useQuery({
    queryKey: ['downloads', 'one', id],
    queryFn: () => api.downloads.get(id),
    enabled: Boolean(id) && !FINISHED.has(created?.status),
    refetchInterval: (q) => (FINISHED.has(q.state.data?.status) ? false : POLL_MS),
    initialData: created ?? undefined,
  });
  return id ? query.data ?? created : null;
}

/** Where a download stands, and the link to it once it is ready. The file opens on this site, signed in, and expires after 7 days. */
export function DownloadState({ item: download }) {
  if (!download) return null;
  const status = wordFor(DOWNLOAD_STATUS_WORDS, download.status, null) ?? { label: download.status, tone: 'neutral' };
  return (
    <div className="an-meta" role="status">
      <Badge tone={status.tone}>{status.label}</Badge>
      {download.background && download.status !== 'ready' && <span className="an-updated">This is a big file, so it’s being made in the background. You’ll get an email when it’s ready.</span>}
      {canOpen(download) && (
        <Button as="a" variant="soft" href={download.fileUrl}>
          <Download size={16} strokeWidth={1.8} aria-hidden="true" />
          {`Open the ${wordFor(FORMAT_WORDS, download.format)} file`}
        </Button>
      )}
    </div>
  );
}

/**
 * "CSV" and "Excel" buttons for one summary file. `request` gives the rest of the DownloadCreate body ({ source, query?, funnelId?, cohort?,
 * range? }). Summary figures only: nothing here lists single visits, by design (7.13).
 */
export function DownloadButtons({ request, disabled, label = 'Download' }) {
  const queries = useQueryClient();
  const [created, setCreated] = useState(null);
  const [problem, setProblem] = useState('');
  const current = useDownloadStatus(created);
  const make = useMutation({
    mutationFn: (format) => api.downloads.create(downloadBody({ ...request(), format })),
    onSuccess: async (download) => {
      setCreated(download);
      await queries.invalidateQueries({ queryKey: ['downloads', 'list'] });
    },
    onError: (error) => setProblem(error.message),
  });
  return (
    <div className="stack">
      <div className="an-actions" role="group" aria-label={label}>
        {['csv', 'xlsx'].map((format) => (
          <Button key={format} variant="outline" disabled={disabled} loading={make.isPending && make.variables === format} onClick={() => { setProblem(''); make.mutate(format); }}>
            <Download size={16} strokeWidth={1.8} aria-hidden="true" />
            {wordFor(FORMAT_WORDS, format)}
          </Button>
        ))}
      </div>
      {problem && <p className="field-error" role="alert">{problem}</p>}
      <DownloadState item={current} />
    </div>
  );
}
