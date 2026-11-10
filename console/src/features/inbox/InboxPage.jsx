import { Link } from 'react-router-dom';
import { staffWith } from '@contracts/access.js';
import { Badge, Button, Chip, ChipRow, EmptyState, ListCard, ListRow, Loadable, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useAllowed, useFilters, usePagedList } from '../../lib/query.js';
import { useStatusNotices } from '../compliance/useStatus.js';
import { NoticeList } from '../compliance/StatusNotices.jsx';
import { THREAD_FILTERS, THREAD_STATUS, handle } from './views.js';
import './inbox.css';

const REFRESH_MS = 20_000;

/** The inbox has its own permission, so someone with only that isn't sent to a status the API would refuse them. */
function Notices() {
  return <NoticeList notices={useStatusNotices()} />;
}

export default function InboxPage() {
  const allowed = useAllowed();
  const [params, setFilter] = useFilters();
  const known = THREAD_FILTERS.some(({ value }) => value === params.get('status'));
  const status = known ? params.get('status') : '';
  const threads = usePagedList('inbox-threads', api.inbox.threads, status ? { status } : {}, { refetchInterval: REFRESH_MS });
  return (
    <>
      <PageHeader title="Inbox" />
      <p className="lead">Your Instagram conversations, and the ones that need you.</p>
      <div className="inbox-tools">
        <Button as={Link} variant="soft" to="/inbox/needs-human">Needs a human</Button>
        <Button as={Link} variant="outline" to="/inbox/why-no-dm">Why no DM?</Button>
      </div>
      {allowed(staffWith('automations')) && <Notices />}
      <ChipRow label="Filter conversations">
        {THREAD_FILTERS.map(({ value, label }) => <Chip key={label} pressed={status === value} onClick={() => setFilter('status', value)}>{label}</Chip>)}
      </ChipRow>
      <Loadable query={threads} label="Loading your conversations" errorTitle="We couldn’t load your conversations">
        {() => (threads.items.length ? (
          <>
            <ListCard>
              {threads.items.map((thread) => (
                <ListRow
                  key={thread.id}
                  as={Link}
                  to={`/inbox/threads/${thread.id}`}
                  title={handle(thread.username)}
                  meta={(
                    <>
                      <span className="thread-row-text">{thread.lastMessage}</span>
                      {thread.lastMessageAt && <span className="thread-row-when">{formatDateTime(thread.lastMessageAt)}</span>}
                    </>
                  )}
                  trailing={<Badge tone={THREAD_STATUS[thread.status].tone}>{THREAD_STATUS[thread.status].label}</Badge>}
                />
              ))}
            </ListCard>
            <LoadMore query={threads} />
          </>
        ) : (
          <EmptyState title={status ? 'Nothing here' : 'No conversations yet'}>
            {status ? 'Try another filter.' : 'When someone DMs you or replies to a story, it shows up here.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
