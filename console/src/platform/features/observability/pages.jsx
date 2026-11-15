import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BackLink, Badge, Banner, ListCard, ListRow, PageHeader, Panel, SelectField, Stat } from '../../../design/index.jsx';
import { Facts, PagedRows, QueryState, When, useOne, usePlatformList } from '../../kit.jsx';
import { api } from '../../api.js';
import { WINDOWS, hoursOf, lastWebhook, opsFigures, worstTone } from './figures.js';

/** Every business, to open one's numbers. The numbers are read one business at a time and never shown side by side. */
export function ObservabilityPage() {
  const query = usePlatformList('businesses', api.businesses);
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Observability" />
      <p className="muted">Errors, Meta use, queue and webhooks for one business. The platform as a whole is on the monitoring dashboards.</p>
      <PagedRows query={query} empty="No businesses yet" emptyText="Numbers appear here once a business exists." label="Loading businesses">
        {(items) => (
          <ListCard>
            {items.map((business) => (
              <ListRow key={business.id} as={Link} to={`/observability/${business.id}`} title={business.name} meta={business.slug} trailing={<Badge>{business.status}</Badge>} />
            ))}
          </ListCard>
        )}
      </PagedRows>
    </div>
  );
}

export function BusinessObservabilityPage() {
  const { id } = useParams();
  const [hours, setHours] = useState(24);
  const query = useOne(['observability', id, hours], () => api.businessOps({ params: { id }, query: { hours } }));
  // "Last webhook" comes from the business's health check of webhooks; where that cannot be read the row says so.
  const health = useQuery({ queryKey: ['p', 'observability-health', id], queryFn: () => api.businessHealth({ params: { id } }), retry: false });

  return (
    <div className="stack">
      <BackLink to="/observability">Observability</BackLink>
      <PageHeader eyebrow="Observability" title="One business" />
      <SelectField label="Window" value={hours} onChange={(event) => setHours(hoursOf(event.target.value))}>
        {WINDOWS.map((w) => <option key={w.hours} value={w.hours}>{w.label}</option>)}
      </SelectField>
      <QueryState query={query} label="Loading numbers">
        {(ops) => {
          const figures = opsFigures(ops);
          const worst = worstTone(figures);
          const webhook = health.isSuccess ? lastWebhook(health.data) : null;
          return (
            <>
              <Banner tone={worst === 'bad' ? 'bad' : worst === 'warn' ? 'warn' : 'good'}>
                {worst === 'good' || worst === 'neutral' ? 'Nothing here needs a look.' : 'Something here needs a look.'}
              </Banner>
              <div className="stat-grid">
                {figures.map((f) => <Stat key={f.key} value={<Badge tone={f.tone}>{f.value}</Badge>} label={f.label} />)}
              </div>
              <Panel title="Webhooks">
                <Facts rows={[
                  ['Webhooks', webhook ? <Badge key="w" tone={webhook.tone}>{webhook.text}</Badge> : 'Not available to your role'],
                  ['Checked', webhook?.at ? <When key="t" value={webhook.at} /> : '—'],
                ]}
                />
              </Panel>
              <Panel title="What these are">
                <ul className="muted">{figures.map((f) => <li key={f.key}><strong>{f.label}.</strong> {f.hint}</li>)}</ul>
              </Panel>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
