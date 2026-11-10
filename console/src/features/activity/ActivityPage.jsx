import { Link } from 'react-router-dom';
import { EmptyState, ListCard, ListRow, LoadMore, Loadable, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { usePagedList } from '../../lib/query.js';
import { ResultBadge } from './ResultBadge.jsx';

function ActivityMeta({ row }) {
  return (
    <>
      {row.text && <span className="activity-text">{row.text}</span>}
      {row.error && <span className="activity-error">{row.error}</span>}
      <span className="activity-when">
        {formatDateTime(row.createdAt)}
        {row.reelId && row.reelSlug && <> · <Link to={`/reels/${row.reelId}`}>{row.reelHeadline || row.reelSlug}</Link></>}
      </span>
    </>
  );
}

export default function ActivityPage() {
  const activity = usePagedList('activity', api.activity.list);
  return (
    <>
      <PageHeader title="DM activity" />
      <p className="lead">Every comment we received, and what happened to it. Newest first.</p>
      <Loadable query={activity} label="Loading your DM activity" errorTitle="We couldn’t load your DM activity">
        {() => (activity.items.length ? (
          <>
            <ListCard>
              {activity.items.map((row) => (
                <ListRow key={row.id} title={`@${row.username || '?'}`} meta={<ActivityMeta row={row} />} trailing={<ResultBadge result={row.result} />} />
              ))}
            </ListCard>
            <LoadMore query={activity} />
          </>
        ) : <EmptyState title="Nothing yet">Comment a reel’s keyword from another account and it will show up here.</EmptyState>)}
      </Loadable>
    </>
  );
}
