import { Badge, Banner, EmptyState, LoadMore, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { usePagedList } from '../../lib/query.js';
import { FIGURE_TEXT } from './shared/catalog.js';
import { AnalyticsLoadable, InsightsTabs, LastUpdated, SourceTag } from './shared/ui.jsx';
import { MEDIA_METRIC_WORDS, formatCount, humanize, mediaMetricText, metaValue, wordFor } from './shared/words.js';

/** A story's state once it has gone (7.3): still live, kept as final, or kept with a final read that was missed (N-12). */
export const FINAL_WORDS = Object.freeze({
  open: { label: 'Live: still updating', tone: 'neel' },
  final: { label: 'Final', tone: 'good' },
  final_incomplete: { label: 'Final may be incomplete', tone: 'warn' },
});

const STORY_FIGURES = ['views', 'reach', 'replies', 'shares', 'follows', 'profile_visits', 'total_interactions'];

const DISCOVERY_NOTES = Object.freeze({
  replies_and_mentions_only: 'Instagram doesn’t let Bhava list your stories on this connection, so only stories someone replied to or mentioned you in are tracked.',
  unknown: 'Bhava is still checking whether Instagram lists your stories on this connection.',
});

function StoryRow({ story }) {
  const final = Object.hasOwn(FINAL_WORDS, story.finalState) ? FINAL_WORDS[story.finalState] : FINAL_WORDS.open;
  const figure = (name) => (story.belowThreshold ? FIGURE_TEXT.belowFive : mediaMetricText(name, story.metrics[name]));
  const navigation = Object.entries(story.navigation ?? {});
  return (
    <article className="an-step" aria-label={`Story posted ${story.postedAt ? formatDateTime(story.postedAt) : 'at a time not known'}`}>
      <div className="an-step-head">
        <span className="an-step-title">{story.postedAt ? formatDateTime(story.postedAt) : 'Time not known'}</span>
        <span className="an-badges">
          {story.tracking === 'not_tracked' ? <Badge>Not tracked</Badge> : <Badge tone={final.tone}>{final.label}</Badge>}
        </span>
      </div>
      {story.tracking === 'not_tracked' ? (
        <p className="muted">Live and reshared stories aren’t tracked: Instagram doesn’t give figures for them.</p>
      ) : (
        <>
          <dl className="an-facts">
            {STORY_FIGURES.map((name) => (
              <div key={name}>
                <dt>{wordFor(MEDIA_METRIC_WORDS, name, humanize(name))}</dt>
                <dd>{figure(name)}</dd>
              </div>
            ))}
            <div>
              <dt>Link sticker taps</dt>
              <dd>{figure('link_clicks')}</dd>
            </div>
          </dl>
          {story.belowThreshold && <p className="muted">Fewer than 5 people saw it, so Instagram doesn’t share its figures.</p>}
          <SourceTag source={story.source} />
          {navigation.length > 0 && (
            <div className="an-step-origins" aria-label="How people moved through it">
              {navigation.map(([key, value]) => <span key={key} className="an-step-origin"><span>{metaValue(key)}</span><b>{formatCount(value)}</b></span>)}
            </div>
          )}
          {story.bhavaVisits !== null && (
            <div className="an-step-origin">
              <span>{`Visits to your store page from the sticker: ${formatCount(story.bhavaVisits)}`}</span>
              <SourceTag source="bhava" />
            </div>
          )}
        </>
      )}
      <LastUpdated at={story.lastUpdatedAt} />
    </article>
  );
}

/** Stories kept after they disappear (7.3), each with its final figures and whether Bhava caught the final read. */
export default function StoriesPage() {
  const stories = usePagedList('insights-stories', api.insights.stories);
  const discovery = stories.data?.pages[0]?.discovery;
  return (
    <>
      <PageHeader eyebrow="Insights" title="Stories" />
      <InsightsTabs />
      {discovery && Object.hasOwn(DISCOVERY_NOTES, discovery) && <Banner tone="info">{DISCOVERY_NOTES[discovery]}</Banner>}
      <Panel title="Your stories" action={<SourceTag source="platform" />}>
        <AnalyticsLoadable query={stories} label="Loading your stories" errorTitle="We couldn’t load your stories">
          {() => (stories.items.length ? (
            <>
              <div className="an-funnel">{stories.items.map((story) => <StoryRow key={story.id} story={story} />)}</div>
              <LoadMore query={stories} />
            </>
          ) : (
            <EmptyState title="No stories yet">Stories are read every two hours while they’re live, and their final figures are kept here after they disappear.</EmptyState>
          ))}
        </AnalyticsLoadable>
      </Panel>
    </>
  );
}
