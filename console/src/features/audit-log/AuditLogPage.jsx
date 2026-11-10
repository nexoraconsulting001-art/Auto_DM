import { EmptyState, ListCard, ListRow, LoadMore, Loadable, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { usePagedList } from '../../lib/query.js';

export default function AuditLogPage() {
  const log = usePagedList('audit-log', api.audit.list);
  return (
    <>
      <PageHeader title="Audit log" />
      <p className="lead">What people did in this business. Newest first.</p>
      <Loadable query={log} label="Loading the audit log" errorTitle="We couldn’t load the audit log">
        {() => (log.items.length ? (
          <>
            <ListCard>
              {log.items.map((row) => (
                <ListRow
                  key={row.id}
                  title={row.action}
                  meta={<span className="activity-when">{formatDateTime(row.createdAt)} · {row.actor}{row.target ? ` · ${row.target}` : ''}</span>}
                />
              ))}
            </ListCard>
            <LoadMore query={log} />
          </>
        ) : <EmptyState title="Nothing yet">Changes to keys, roles and settings will show up here.</EmptyState>)}
      </Loadable>
    </>
  );
}
