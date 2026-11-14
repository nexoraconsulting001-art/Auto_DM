import { HEALTH_TONE } from '../../lib/rules.js';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink, Badge, Banner, Button, ListCard, ListRow, PageHeader, Panel } from '../../../design/index.jsx';
import { Facts, PagedRows, QueryState, When, useAct, useCan, useOne, usePlatformList } from '../../kit.jsx';
import { word, worstFirst } from '../../lib/rules.js';
import { api } from '../../api.js';

const primitive = ([, value]) => ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 80;

export function HealthPage() {
  const query = usePlatformList('health', api.health);
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Health" />
      <p className="muted">Every business, worst first. A check that could not run is shown as such, never as fine.</p>
      <PagedRows query={query} empty="No businesses to check" emptyText="Health appears here once a business exists." label="Loading health">
        {() => (
          <ListCard>
            {worstFirst(query.items).map((row) => {
              const lastRan = row.checks.map((check) => check.lastRanAt).filter(Boolean).sort().at(-1) ?? null;
              return (
                <ListRow
                  key={row.tenantId}
                  as={Link}
                  to={`/health/${row.tenantId}`}
                  title={row.tenantName}
                  meta={<>{row.score === null ? 'No score yet' : `Score ${row.score}`} · last check <When value={lastRan} empty="never" /></>}
                  trailing={<Badge tone={HEALTH_TONE[row.worst]}>{word('health', row.worst)}</Badge>}
                />
              );
            })}
          </ListCard>
        )}
      </PagedRows>
    </div>
  );
}

export function BusinessHealthPage() {
  const { id } = useParams();
  const act = useAct();
  const can = useCan();
  const query = useOne(['health', id], () => api.businessHealth({ params: { id } }));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    setRunning(true);
    setError('');
    try {
      await act(() => api.runHealth({ params: { id } }), 'The checks have run.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="stack">
      <BackLink to="/health">Health</BackLink>
      <QueryState query={query} label="Loading checks">
        {(health) => (
          <>
            <PageHeader
              eyebrow="Health"
              title={health.tenantName}
              actions={can('platform.runHealth') && <Button variant="soft" loading={running} onClick={run}>Run the checks</Button>}
            />
            {error && <Banner tone="bad">{error}</Banner>}
            <Banner tone={HEALTH_TONE[health.worst] === 'good' ? 'good' : HEALTH_TONE[health.worst]}>
              {word('health', health.worst)}{health.score === null ? '' : ` · score ${health.score} of 100`}
            </Banner>
            {health.checks.length === 0 && <p className="muted">No checks have run yet.</p>}
            {health.checks.map((check) => (
              <Panel key={check.check} title={check.label} action={<Badge tone={HEALTH_TONE[check.status]}>{word('health', check.status)}</Badge>}>
                <Facts rows={[
                  ['Last ran', <When key="w" value={check.lastRanAt} empty="Never" />],
                  ...Object.entries(check.detail ?? {}).filter(primitive).map(([key, value]) => [key.replace(/_/g, ' '), String(value)]),
                ]}
                />
              </Panel>
            ))}
          </>
        )}
      </QueryState>
    </div>
  );
}
