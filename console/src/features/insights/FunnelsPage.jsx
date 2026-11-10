import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Chip, ChipRow, EmptyState, LoadMore, PageHeader, Panel, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { FIGURE_TEXT } from './shared/catalog.js';
import { KIND_FILTERS, funnelSteps, linkWords } from './shared/figures.js';
import { AnalyticsLoadable, InsightsTabs, LastUpdated, SourceTag } from './shared/ui.jsx';
import { CHANNEL_WORDS, KIND_WORDS, wordFor } from './shared/words.js';

const STORY_FILTER = { value: 'story', label: 'Stories' };

function FunnelRow({ funnel, media }) {
  const steps = funnelSteps(funnel);
  return (
    <Link className="an-row" to={`/analytics/funnels/${encodeURIComponent(funnel.mediaId)}`}>
      <Thumb src={media?.thumbnailUrl} />
      <span className="an-row-main">
        <span className="an-row-title">{media?.caption || `${wordFor(KIND_WORDS, funnel.kind)} on ${wordFor(CHANNEL_WORDS, funnel.channel)}`}</span>
        <span className="an-badges">
          <Badge>{wordFor(KIND_WORDS, funnel.kind)}</Badge>
          <span className="an-row-meta">{linkWords(funnel)}</span>
        </span>
        <span className="an-row-figures">
          {steps.map((step) => (
            <span key={step.stage}>{step.title}: <b>{step.unavailable ? 'not measured' : (step.stage === 'sales' && step.amount) || step.value || 'by source'}</b></span>
          ))}
        </span>
      </span>
    </Link>
  );
}

/** Every reel, post and story with an automation, and what each led to (7.4). */
export default function FunnelsPage() {
  const [params, setFilter] = useFilters();
  const filters = [...KIND_FILTERS, STORY_FILTER];
  const kind = filters.some((f) => f.value === params.get('kind')) ? params.get('kind') : 'all';
  const funnels = usePagedList('insights-funnels', api.insights.funnels, { kind });
  // Captions and pictures come from the insights cache. Without them a row still reads, by its type.
  const media = useQuery({ queryKey: ['insights', 'media-names'], queryFn: () => api.insights.media({ limit: 100 }), retry: false });
  const byId = new Map((media.data?.items ?? []).map((item) => [item.id, item]));

  return (
    <>
      <PageHeader eyebrow="Insights" title="Funnels" />
      <InsightsTabs />
      <p className="lead">From a comment to a sale, for each post with an automation. Every step says where its figure comes from.</p>
      <ChipRow label="Type of post">
        {filters.map((filter) => <Chip key={filter.value} pressed={filter.value === kind} onClick={() => setFilter('kind', filter.value === 'all' ? '' : filter.value)}>{filter.label}</Chip>)}
      </ChipRow>
      <Panel title="Your funnels" action={<SourceTag source="bhava" />}>
        <AnalyticsLoadable query={funnels} label="Loading your funnels" errorTitle="We couldn’t load your funnels">
          {() => (funnels.items.length ? (
            <>
              <div className="an-rows">{funnels.items.map((funnel) => <FunnelRow key={`${funnel.channel}:${funnel.mediaId}`} funnel={funnel} media={byId.get(funnel.mediaId)} />)}</div>
              <LoadMore query={funnels} />
              <LastUpdated at={funnels.items[0]?.lastUpdatedAt} />
            </>
          ) : (
            <EmptyState title="No funnels yet">{`A post gets a funnel once an automation on it has had a comment. ${FIGURE_TEXT.noData} until then.`}</EmptyState>
          ))}
        </AnalyticsLoadable>
      </Panel>
    </>
  );
}
