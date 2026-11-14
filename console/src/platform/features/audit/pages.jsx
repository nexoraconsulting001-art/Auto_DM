import { useState } from 'react';
import { Button, ListCard, ListRow, PageHeader, TextField } from '../../../design/index.jsx';
import { PagedRows, When, usePlatformList } from '../../kit.jsx';
import { api } from '../../api.js';

const shown = ([, value]) => ['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 60;

/** What Bhava's team did, newest first. Details are ids only: nothing personal is on the audit log. */
export function AuditPage() {
  const [draft, setDraft] = useState({ tenantId: '', actor: '', action: '' });
  const [filters, setFilters] = useState({});
  const query = usePlatformList('audit', api.auditLog, filters);
  const set = (name) => (event) => setDraft((current) => ({ ...current, [name]: event.target.value }));
  const idOk = draft.tenantId === '' || /^\d+$/.test(draft.tenantId);

  function apply(event) {
    event.preventDefault();
    if (!idOk) return;
    setFilters(Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)));
  }

  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Audit" />
      <form className="stack" onSubmit={apply} noValidate>
        <TextField label="Business number" inputMode="numeric" value={draft.tenantId} onChange={set('tenantId')} error={idOk ? undefined : 'Use a business number'} />
        <TextField label="Who" hint="For example platform:12" value={draft.actor} onChange={set('actor')} />
        <TextField label="What" hint="For example platform.pause" value={draft.action} onChange={set('action')} />
        <Button type="submit" variant="soft">Filter</Button>
      </form>
      <PagedRows query={query} empty="Nothing on the log" emptyText="Nothing matches. Clear a filter to see more." label="Loading the audit log">
        {(items) => (
          <ListCard>
            {items.map((row) => (
              <ListRow
                key={row.id}
                title={row.action}
                meta={<>{row.actor}{row.tenantId ? ` · business ${row.tenantId}` : ''}{row.target ? ` · ${row.target}` : ''} · <When value={row.at} />{Object.entries(row.details ?? {}).filter(shown).map(([key, value]) => ` · ${key}: ${value}`).join('')}</>}
              />
            ))}
          </ListCard>
        )}
      </PagedRows>
    </div>
  );
}
