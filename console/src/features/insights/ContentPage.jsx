import { Link } from 'react-router-dom';
import { Badge, Chip, ChipRow, EmptyState, LoadMore, PageHeader, Panel, Thumb, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { FIGURE_TEXT } from './shared/catalog.js';
import { KIND_FILTERS } from './shared/figures.js';
import { AnalyticsLoadable, InsightsTabs, LastUpdated, SourceTag } from './shared/ui.jsx';
import { KIND_WORDS, formatCount, wordFor } from './shared/words.js';

/** A figure from the post's latest snapshot, or the words for why there isn't one. */
const metricText = (metrics, name) => (typeof metrics?.[name] === 'number' ? formatCount(metrics[name]) : FIGURE_TEXT.noData);

export function MediaRow({ media, to }) {
  return (
    <Link className="an-row" to={to}>
      <Thumb src={media.thumbnailUrl} />
      <span className="an-row-main">
        <span className="an-row-title">{media.caption || 'No caption'}</span>
        <span className="an-badges">
          <Badge>{wordFor(KIND_WORDS, media.kind)}</Badge>
          {media.deleted && <Badge tone="warn">Deleted on Instagram</Badge>}
          {media.estimated?.length > 0 && <Badge tone="neel">Some figures estimated</Badge>}
        </span>
        <span className="an-row-figures">
          <span><b>{metricText(media.metrics, 'views')}</b> views</span>
          <span><b>{metricText(media.metrics, 'reach')}</b> reach</span>
          <span><b>{metricText(media.metrics, 'total_interactions')}</b> interactions</span>
        </span>
        <span className="an-row-meta">{media.postedAt ? `Posted ${formatDate(media.postedAt)}` : 'Date not known'}</span>
      </span>
    </Link>
  );
}

/** Each post, reel and carousel with its latest figures (7.2). Deleted ones keep what was stored and say so. */
export default function ContentPage() {
  const [params, setFilter] = useFilters();
  const kind = KIND_FILTERS.some((f) => f.value === params.get('kind')) ? params.get('kind') : 'all';
  const includeDeleted = params.get('deleted') === 'hide' ? 'false' : 'true';
  const media = usePagedList('insights-media', api.insights.media, { kind, includeDeleted });
  // Stories have their own screen, with the figures that matter for a story; "All" here means posts, reels and carousels.
  const items = media.items.filter((item) => item.kind !== 'story');

  return (
    <>
      <PageHeader eyebrow="Insights" title="Posts and reels" />
      <InsightsTabs />
      <ChipRow label="Type of post">
        {KIND_FILTERS.map((filter) => (
          <Chip key={filter.value} pressed={filter.value === kind} onClick={() => setFilter('kind', filter.value === 'all' ? '' : filter.value)}>{filter.label}</Chip>
        ))}
      </ChipRow>
      <Toggle label="Show posts deleted on Instagram" checked={includeDeleted === 'true'} onChange={(event) => setFilter('deleted', event.target.checked ? '' : 'hide')} />
      <Panel title="Latest figures" action={<SourceTag source="platform" />}>
        <AnalyticsLoadable query={media} label="Loading your posts" errorTitle="We couldn’t load your posts">
          {() => (items.length || media.hasNextPage ? (
            <>
              <div className="an-rows">
                {items.map((item) => <MediaRow key={item.id} media={item} to={`/analytics/content/${encodeURIComponent(item.id)}`} />)}
              </div>
              <LoadMore query={media} />
              <LastUpdated at={items[0]?.lastUpdatedAt} />
            </>
          ) : (
            <EmptyState title="No posts yet">Posts and reels from the last two years appear here once Instagram is connected. New ones show up within a few hours.</EmptyState>
          ))}
        </AnalyticsLoadable>
      </Panel>
    </>
  );
}
