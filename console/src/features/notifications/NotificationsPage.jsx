import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { isAllowed } from '@contracts/access.js';
import { Banner, Button, Chip, ChipRow, EmptyState, Loadable, LoadMore, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { plural } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { features } from '../index.js';
import '../account/account.css';
import { linkInConsole, whenText } from './rules.js';

const KEY = 'notifications';

/** The console pages this person may open: a notification about anything else just goes from unread to read. */
function usePagesHere() {
  const { session } = useSession();
  return useMemo(
    () => features.filter((feature) => isAllowed(session.user, feature.access)).flatMap((feature) => feature.routes.map((route) => route.path)),
    [session.user],
  );
}

function Note({ item, onOpen }) {
  const unread = !item.readAt;
  return (
    <button type="button" className="acct-note" onClick={() => onOpen(item)}>
      <span className={unread ? 'acct-note-dot' : 'acct-note-dot acct-note-dot-read'} aria-hidden="true" />
      <span className="acct-row-main">
        <span className="acct-row-title">
          {unread && <span className="sr-only">Unread: </span>}
          {item.title}
        </span>
        {item.body && <span className="acct-row-meta">{item.body}</span>}
        <span className="acct-note-when">{whenText(item.createdAt)}</span>
      </span>
    </button>
  );
}

/**
 * What Bhava has told this person about this business (PRD 5.13): the in-app list, newest first. Opening one marks it
 * read and goes to what it is about. Each person sees only their own list in the business in use.
 */
export default function NotificationsPage() {
  const queries = useQueryClient();
  const navigate = useNavigate();
  const pages = usePagesHere();
  const [params, setFilter] = useFilters();
  const unreadOnly = params.get('show') === 'unread';
  const list = usePagedList(KEY, api.notifications.list, unreadOnly ? { unread: '1' } : {});
  const unread = list.data?.pages?.[0]?.unread ?? 0;
  const markRead = useMutation({
    mutationFn: (body) => api.notifications.markRead(body),
    onSettled: () => queries.invalidateQueries({ queryKey: [KEY] }),
  });

  function open(item) {
    if (!item.readAt) markRead.mutate({ ids: [item.id] });
    const to = linkInConsole(item.link, pages);
    if (to) navigate(to);
  }

  return (
    <>
      <PageHeader
        eyebrow="Inbox from Bhava"
        title="Notifications"
        actions={<Link className="panel-link" to="/notifications/settings">Choose what you hear about</Link>}
      />
      <ChipRow label="Show">
        <Chip pressed={!unreadOnly} onClick={() => setFilter('show', '')}>All</Chip>
        <Chip pressed={unreadOnly} onClick={() => setFilter('show', 'unread')}>Unread</Chip>
      </ChipRow>
      <Panel
        title={list.isPending ? 'Your notifications' : unread ? plural(unread, 'unread notification') : 'All caught up'}
        action={unread > 0 && <Button variant="soft" loading={markRead.isPending && markRead.variables?.all} onClick={() => markRead.mutate({ all: true })}>Mark all as read</Button>}
      >
        {markRead.isError && <Banner tone="bad">{markRead.error.message}</Banner>}
        <Loadable query={list} label="Loading your notifications" errorTitle="We couldn’t load your notifications">
          {() => (list.items.length ? (
            <>
              <div className="acct-rows">
                {list.items.map((item) => <Note key={item.id} item={item} onOpen={open} />)}
              </div>
              <LoadMore query={list} />
            </>
          ) : unreadOnly ? (
            <EmptyState title="Nothing unread">You’ve seen everything for this business.</EmptyState>
          ) : (
            <EmptyState title="Nothing new">Orders, alerts and reports for this business show up here.</EmptyState>
          ))}
        </Loadable>
      </Panel>
    </>
  );
}
