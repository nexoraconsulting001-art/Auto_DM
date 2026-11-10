import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Button, Chip, ChipRow, EmptyState, ListCard, Loadable, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useFilters, usePagedList, useRefresh } from '../../lib/query.js';
import { describeReason } from '../compliance/reasons.js';
import { NEEDS_HUMAN_KIND, handle } from './views.js';
import './inbox.css';

const REFRESH_MS = 20_000;

function Item({ item }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const resolve = useMutation({
    mutationFn: () => api.inbox.resolve(item.id),
    onSuccess: async () => {
      toast('Marked as done.');
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  const open = item.status === 'open';
  return (
    <article className="needs-item">
      <div className="needs-item-head">
        <span className="needs-item-who">{handle(item.username)}</span>
        <Badge tone={open ? 'warn' : 'neutral'}>{NEEDS_HUMAN_KIND[item.kind] ?? item.kind}</Badge>
      </div>
      {item.text && <p className="needs-item-text">{item.text}</p>}
      <p className="muted">{describeReason(item.reason)} {formatDateTime(item.createdAt)}</p>
      <div className="needs-item-actions">
        {item.threadId && <Button as={Link} variant="soft" to={`/inbox/threads/${item.threadId}`}>Open chat</Button>}
        {item.commentId && <Button as={Link} variant="outline" to={`/inbox/why-no-dm?commentId=${encodeURIComponent(item.commentId)}`}>Why no DM?</Button>}
        {open && <Button variant="outline" loading={resolve.isPending} onClick={() => resolve.mutate()}>Mark as done</Button>}
      </div>
    </article>
  );
}

export default function NeedsHumanPage() {
  const [params, setFilter] = useFilters();
  const status = params.get('status') === 'resolved' ? 'resolved' : 'open';
  const items = usePagedList('needs-human', api.inbox.needsHuman, { status }, { refetchInterval: REFRESH_MS });
  return (
    <>
      <BackLink to="/inbox">Inbox</BackLink>
      <PageHeader title="Needs a human" />
      <p className="lead">Complaints, people asking for you, and messages that didn’t go.</p>
      <ChipRow label="Filter items">
        <Chip pressed={status === 'open'} onClick={() => setFilter('status', '')}>To do</Chip>
        <Chip pressed={status === 'resolved'} onClick={() => setFilter('status', 'resolved')}>Done</Chip>
      </ChipRow>
      <Loadable query={items} label="Loading what needs you" errorTitle="We couldn’t load what needs you">
        {() => (items.items.length ? (
          <>
            <ListCard>{items.items.map((item) => <Item key={item.id} item={item} />)}</ListCard>
            <LoadMore query={items} />
          </>
        ) : (
          <EmptyState title={status === 'open' ? 'All caught up' : 'Nothing done yet'}>
            {status === 'open' ? 'Anything that needs you will show up here.' : 'Items you mark as done are kept here.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
