import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { BackLink, Badge, Button, Card, PageHeader, Panel, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { FIGURE_TEXT } from './shared/catalog.js';
import { funnelSteps, linkWords } from './shared/figures.js';
import { AnalyticsLoadable, LastUpdated, SourceTag } from './shared/ui.jsx';
import { CHANNEL_WORDS, KIND_WORDS, formatCount, wordFor } from './shared/words.js';

/** One step: its count or why there is none, the rate from the step before, and where each part came from (7.15). */
export function FunnelStep({ step }) {
  return (
    <li className={`an-step${step.unavailable ? ' an-step-off' : ''}`}>
      <div className="an-step-head">
        <span className="an-step-title">{step.title}</span>
        <span className="an-step-value">{step.unavailable ? step.note : step.value ?? ''}</span>
      </div>
      {step.amount && <span className="an-tile-note">{step.amount}</span>}
      {!step.unavailable && step.note && <span className="an-tile-note">{step.note}</span>}
      {step.rate && <span className="an-tile-note">{step.rate}</span>}
      {step.source && <SourceTag source={step.sourceCode} />}
      {step.origins.length > 0 && (
        <ul className="an-step-origins">
          {step.origins.map((origin) => (
            <li key={origin.key} className="an-step-origin">
              <span>{origin.label}</span>
              <span><b>{origin.value}</b> <span className="an-col-source">{origin.source}</span></span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function FunnelSteps({ funnel }) {
  const steps = funnelSteps(funnel).map((view, i) => ({ ...view, sourceCode: funnel.steps[i].source }));
  return <ol className="an-funnel" aria-label="Funnel steps">{steps.map((step) => <FunnelStep key={step.stage} step={step} />)}</ol>;
}

function Funnel({ funnel, media }) {
  return (
    <>
      <Card>
        <div className="an-row">
          <Thumb src={media?.thumbnailUrl} />
          <span className="an-row-main">
            <span className="an-row-title">{media?.caption || `${wordFor(KIND_WORDS, funnel.kind)} on ${wordFor(CHANNEL_WORDS, funnel.channel)}`}</span>
            <span className="an-badges">
              <Badge>{wordFor(KIND_WORDS, funnel.kind)}</Badge>
              <Badge>{wordFor(CHANNEL_WORDS, funnel.channel)}</Badge>
            </span>
          </span>
        </div>
        <p><strong>Link: </strong>{linkWords(funnel)}</p>
        <p className="muted">The link and its mode decide what Bhava can measure. With one tap to another site the shopper goes straight there, so Bhava never counts that tap.</p>
      </Card>
      <Panel title="From comment to sale">
        <FunnelSteps funnel={funnel} />
        <p className="muted">{`A rate over fewer than 20 shows “${FIGURE_TEXT.lowVolume}”. Cancelled and refunded orders are left out.`}</p>
        <LastUpdated at={funnel.lastUpdatedAt} />
      </Panel>
      <Panel title="Alongside, from Instagram" action={<SourceTag source={funnel.platform.source} />}>
        <dl className="an-facts">
          <div><dt>Reach</dt><dd>{funnel.platform.reach === null ? FIGURE_TEXT.noData : formatCount(funnel.platform.reach)}</dd></div>
          <div><dt>{FIGURE_TEXT.viewsColumn}</dt><dd>{funnel.platform.views === null ? FIGURE_TEXT.noData : formatCount(funnel.platform.views)}</dd></div>
        </dl>
        <p className="muted">Instagram’s figures are shown beside Bhava’s and never added to them.</p>
        <LastUpdated at={funnel.platform.lastUpdatedAt} />
        {media && <Button as={Link} variant="soft" to={`/analytics/content/${encodeURIComponent(funnel.mediaId)}`}>See every figure for this post</Button>}
      </Panel>
    </>
  );
}

/** The Bhava funnel for one reel, post or story (7.4): Comments, DMs, Seen, Taps or visits, Sales, each with its source label. */
export default function FunnelPage() {
  const { id } = useParams();
  const funnel = useQuery({ queryKey: ['insights', 'funnel', id], queryFn: () => api.insights.funnel(id) });
  // The caption and picture are Instagram's, from the same cache. A post without them still shows its funnel.
  const media = useQuery({ queryKey: ['insights', 'media', id], queryFn: () => api.insights.mediaDetail(id), retry: false });
  return (
    <>
      <BackLink to="/analytics/funnels">Funnels</BackLink>
      <PageHeader eyebrow="Insights" title="Funnel" />
      <AnalyticsLoadable query={funnel} detail label="Loading this funnel" errorTitle="We couldn’t load this funnel">
        {(data) => <Funnel funnel={data} media={media.data} />}
      </AnalyticsLoadable>
    </>
  );
}
