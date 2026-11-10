import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { BackLink, Badge, Button, Card, PageHeader, Panel, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { FIGURE_TEXT } from './shared/catalog.js';
import { growthAt } from './shared/figures.js';
import { AnalyticsLoadable, BarList, EstimatedNote, LastUpdated, SourceTag } from './shared/ui.jsx';
import { BREAKDOWN_WORDS, KIND_WORDS, formatCount, mediaMetricRows, mediaMetricText, metaValue, wordFor } from './shared/words.js';

/** Instagram's own address for a post, and nothing else: the permalink is shown only when it is one. */
const instagramLink = (url) => (/^https:\/\/(www\.)?instagram\.com\//.test(url ?? '') ? url : '');

function Growth({ media }) {
  const ages = growthAt(media.growth);
  return (
    <Panel title="How it grew" action={<SourceTag source="platform" />}>
      <div className="an-table-wrap">
        <table className="an-table">
          <caption className="sr-only">Views and reach at each age</caption>
          <thead><tr><th scope="col">Age</th><th scope="col">Views</th><th scope="col">Reach</th></tr></thead>
          <tbody>
            {ages.map((age) => (
              <tr key={age.minutes}>
                <th scope="row">{age.label}</th>
                <td>{age.snapshot ? mediaMetricText('views', age.snapshot.metrics.views) : FIGURE_TEXT.noData}</td>
                <td>{age.snapshot ? mediaMetricText('reach', age.snapshot.metrics.reach) : FIGURE_TEXT.noData}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">{`${media.growth.length} ${media.growth.length === 1 ? 'snapshot' : 'snapshots'} stored. Bhava keeps one each time it reads this post.`}</p>
    </Panel>
  );
}

function Media({ media }) {
  const rows = mediaMetricRows(media.metrics);
  const link = instagramLink(media.permalink);
  const breakdowns = Object.entries(media.breakdowns ?? {}).filter(([, values]) => Object.keys(values).length);
  return (
    <>
      <Card>
        <div className="an-row">
          <Thumb src={media.thumbnailUrl} tall />
          <span className="an-row-main">
            <span className="an-badges">
              <Badge>{wordFor(KIND_WORDS, media.kind)}</Badge>
              {media.deleted && <Badge tone="warn">Deleted on Instagram</Badge>}
            </span>
            <span className="an-row-meta">{media.postedAt ? `Posted ${formatDate(media.postedAt)}` : 'Date not known'}</span>
            {media.deleted && <span className="an-row-meta">Bhava keeps what it stored before the post was deleted, and has stopped reading it.</span>}
          </span>
        </div>
        <p className="an-row-title">{media.caption || 'No caption'}</p>
        <div className="row-actions">
          <Button as={Link} variant="soft" to={`/analytics/funnels/${encodeURIComponent(media.id)}`}>See its funnel</Button>
          {link && (
            <Button as="a" variant="outline" href={link} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} strokeWidth={1.8} aria-hidden="true" />
              Open on Instagram
            </Button>
          )}
        </div>
      </Card>
      <Panel title="Figures" action={<SourceTag source={media.source} />}>
        {rows.length ? (
          <dl className="an-facts">
            {rows.map((row) => (
              <div key={row.name}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
                {media.estimated.includes(row.name) && <EstimatedNote />}
              </div>
            ))}
          </dl>
        ) : <p className="muted">{FIGURE_TEXT.noData}. Figures appear after Bhava first reads this post.</p>}
        <LastUpdated at={media.lastUpdatedAt} />
      </Panel>
      {media.historicImpressions !== null && (
        <Panel title="Impressions (before July 2024)" action={<SourceTag source="platform" />}>
          <p className="an-tile-value">{formatCount(media.historicImpressions)}</p>
          <p className="muted">Instagram counted impressions for posts made before 2 July 2024. They are kept apart and never added to views.</p>
        </Panel>
      )}
      <Growth media={media} />
      {breakdowns.map(([name, values]) => (
        <Panel key={name} title={wordFor(BREAKDOWN_WORDS, name, metaValue(name))} action={<SourceTag source="platform" />}>
          <BarList label={name} items={Object.entries(values).map(([key, value]) => ({ key, label: metaValue(key), value }))} />
        </Panel>
      ))}
      {media.lastUpdatedAt && <p className="muted">{`Read from Instagram ${formatDateTime(media.lastUpdatedAt)}.`}</p>}
    </>
  );
}

export default function MediaPage() {
  const { id } = useParams();
  const media = useQuery({ queryKey: ['insights', 'media', id], queryFn: () => api.insights.mediaDetail(id) });
  return (
    <>
      <BackLink to="/analytics/content">Posts and reels</BackLink>
      <PageHeader eyebrow="Insights" title="Post figures" />
      <AnalyticsLoadable query={media} detail label="Loading this post" errorTitle="We couldn’t load this post">
        {(data) => <Media media={data} />}
      </AnalyticsLoadable>
    </>
  );
}
