import React, { useState } from 'react';
import { Image, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, Divider, ListRow, Section, Sparkline, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { Loadable, Page, Refusal, SourceTag, pickDocument, useConnection } from '../products/kit.js';
import { REPORT_RULE, UploadRefused, fileProblem, filePart } from '../products/upload.js';
import { INSIGHTS_KEY, StatusBanner, Updated, useInsightsStatus, useUser } from './InsightsScreen.js';
import { busiest, figureText, formatHour, moneyText } from './figures.js';

const KINDS = ['all', 'reel', 'feed', 'carousel', 'story'];
/** Metric names the API uses on posts, in the order a phone shows them. Any other the API adds shows after these. */
const MEDIA_METRICS = ['views', 'reach', 'total_interactions', 'likes', 'comments', 'shares', 'saved', 'replies', 'follows', 'profile_visits'];
const metricLabel = (t, name) => (MEDIA_METRICS.includes(name) ? t(`insights.metric.${name}`) : name.replace(/_/g, ' '));

/** Every page of a list, for "Show more". */
function usePaged(key, fetchPage) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: null,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
  });
}
const itemsOf = (query) => (query.data?.pages ?? []).flatMap((p) => p.items ?? []);

function MoreButton({ query, testID }) {
  const { t } = useStrings();
  if (!query.hasNextPage) return null;
  return <Button testID={testID} kind="quiet" label={t('insights.showMore')} busy={query.isFetchingNextPage} onPress={() => query.fetchNextPage()} />;
}

function Thumb({ uri }) {
  const theme = useTheme();
  return <Image source={uri ? { uri } : undefined} accessibilityIgnoresInvertColors style={{ width: 48, height: 48, borderRadius: theme.radius.small, backgroundColor: theme.color.surfaceSunken }} />;
}

/** Posts and reels (7.2): each with its views and reach, or why there is none, and its source. */
export function ContentScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const { offline } = useConnection();
  const [kind, setKind] = useState('all');
  const status = useInsightsStatus();
  const media = usePaged([...INSIGHTS_KEY, 'media', kind], (page) => api.insights.media({ kind, ...page }));
  const items = itemsOf(media);
  return (
    <Page testID="screen-insights-content" offline={offline}>
      <Text variant="page">{t('insights.content.title')}</Text>
      <StatusBanner status={status.data} />
      <Choices testID="insights-kind" label={t('insights.kind.label')} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: t(`insights.kind.${k}`) }))} />
      <Loadable query={media} empty={!items.length} testID="insights-media" emptyTitle={t('insights.content.empty')}>
        <Card>
          {items.map((item, i) => (
            <View key={item.id}>
              {i ? <Divider /> : null}
              <ListRow
                testID={`insights-media-${item.id}`}
                start={<Thumb uri={item.thumbnailUrl} />}
                title={item.caption || t(`insights.kind.${item.kind}`)}
                subtitle={`${t('insights.metric.views')}: ${figureText(t, item.metrics?.views ?? null)} · ${t('insights.metric.reach')}: ${figureText(t, item.metrics?.reach ?? null)}${item.deleted ? ` · ${t('insights.deleted')}` : ''}`}
                onPress={() => navigation.navigate('insights.media', { id: item.id })}
              />
            </View>
          ))}
        </Card>
        <SourceTag code={items[0]?.source} testID="insights-media-source" />
        <MoreButton query={media} testID="insights-media-more" />
      </Loadable>
    </Page>
  );
}

/** One post's figures, how they grew, and its Bhava funnel (7.2, 7.4). */
export function MediaScreen({ route }) {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const { offline } = useConnection();
  const id = String(route?.params?.id ?? '');
  const detail = useQuery({ queryKey: [...INSIGHTS_KEY, 'media', 'detail', id], queryFn: () => api.insights.mediaDetail(id), enabled: Boolean(id) });
  const data = detail.data;
  const names = data ? [...MEDIA_METRICS.filter((m) => m in data.metrics), ...Object.keys(data.metrics).filter((m) => !MEDIA_METRICS.includes(m))] : [];
  const growth = (data?.growth ?? []).map((g) => g.metrics?.views).filter((v) => typeof v === 'number');
  return (
    <Page testID="screen-insights-media" offline={offline}>
      <Loadable query={detail} testID="insights-media-detail">
        {data ? (
          <>
            <Text variant="title">{data.caption || t(`insights.kind.${data.kind}`)}</Text>
            {data.deleted ? <Badge label={t('insights.deleted')} /> : null}
            <Card testID="insights-media-metrics">
              <SourceTag code={data.source} testID="insights-media-detail-source" />
              {names.length ? names.map((name) => (
                <View key={name} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text variant="small">{metricLabel(t, name)}{data.estimated.includes(name) ? ` (${t('insights.estimatedShort')})` : ''}</Text>
                  <Text variant="small" testID={`insights-media-metric-${name}`}>{figureText(t, data.metrics[name])}</Text>
                </View>
              )) : <Text variant="small">{t('insights.figure.notAvailable')}</Text>}
              {data.historicImpressions !== null ? <Text variant="caption">{t('insights.historicImpressions', { count: figureText(t, data.historicImpressions) })}</Text> : null}
            </Card>
            <Card>
              <Text variant="title">{t('insights.growth')}</Text>
              {growth.length >= 2 ? <Sparkline values={growth} label={t('insights.chartLabel', { title: t('insights.growth'), values: growth.join(', ') })} /> : <Text variant="small" testID="insights-growth-state">{t('insights.figure.noData')}</Text>}
            </Card>
            <Updated at={data.lastUpdatedAt} />
            <Button testID="insights-media-funnel" kind="secondary" label={t('insights.funnels.open')} onPress={() => navigation.navigate('insights.funnel', { id })} />
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}

/** Stories (7.3): kept after they expire, "<5" below Meta's threshold, and how they were found. */
export function StoriesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const { offline } = useConnection();
  const stories = usePaged([...INSIGHTS_KEY, 'stories'], (page) => api.insights.stories(page));
  const items = itemsOf(stories);
  const discovery = stories.data?.pages?.[0]?.discovery;
  return (
    <Page testID="screen-insights-stories" offline={offline}>
      <Text variant="page">{t('insights.stories.title')}</Text>
      {discovery === 'replies_and_mentions_only' ? <Banner tone="info" testID="insights-stories-discovery">{t('insights.stories.discovery')}</Banner> : null}
      <Loadable query={stories} empty={!items.length} testID="insights-stories" emptyTitle={t('insights.stories.empty')}>
        <Card>
          {items.map((story, i) => (
            <View key={story.id}>
              {i ? <Divider /> : null}
              <ListRow
                testID={`insights-story-${story.id}`}
                title={t(`insights.stories.final.${story.finalState}`)}
                subtitle={[
                  `${t('insights.metric.views')}: ${story.belowThreshold ? t('insights.figure.belowFive') : figureText(t, story.metrics?.views ?? null)}`,
                  `${t('insights.metric.replies')}: ${story.belowThreshold ? t('insights.figure.belowFive') : figureText(t, story.metrics?.replies ?? null)}`,
                  story.tracking === 'not_tracked' ? t('insights.stories.notTracked') : null,
                  story.bhavaVisits === null ? null : t('insights.stories.visits', { count: figureText(t, story.bhavaVisits) }),
                ].filter(Boolean).join(' · ')}
              />
            </View>
          ))}
        </Card>
        <SourceTag code={items[0]?.source} />
        <MoreButton query={stories} testID="insights-stories-more" />
      </Loadable>
    </Page>
  );
}

const RANKS = ['views', 'reach', 'interactions', 'dms', 'taps_or_visits', 'sales'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Top content (7.5), ranked at one shared age, and the best time to post. Sales are money and follow the revenue rule. */
export function TopScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const user = useUser();
  const { offline } = useConnection();
  const [rank, setRank] = useState('views');
  const top = useQuery({ queryKey: [...INSIGHTS_KEY, 'top', rank], queryFn: () => api.insights.top({ rank }) });
  const best = useQuery({ queryKey: [...INSIGHTS_KEY, 'bestTime'], queryFn: () => api.insights.bestTime() });
  const items = top.data?.items ?? [];
  const peak = best.data?.available ? busiest(best.data.cells, 'value') : null;
  return (
    <Page testID="screen-insights-top" offline={offline}>
      <Text variant="page">{t('insights.top.title')}</Text>
      <Choices testID="insights-rank" label={t('insights.top.rankBy')} value={rank} onChange={setRank} options={RANKS.map((r) => ({ value: r, label: t(`insights.rank.${r}`) }))} />
      <Loadable query={top} empty={!items.length} testID="insights-top" emptyTitle={t('insights.top.empty')}>
        <Card>
          {items.map((item, i) => (
            <View key={item.mediaId}>
              {i ? <Divider /> : null}
              <ListRow
                testID={`insights-top-${item.mediaId}`}
                start={<Text variant="title">{i + 1}</Text>}
                title={item.caption || t(`insights.kind.${item.kind}`)}
                end={<Text variant="small" testID={`insights-top-${item.mediaId}-value`}>{rank === 'sales' ? moneyText(t, user, item.value, item.value === null ? 'no_data' : 'ok') : figureText(t, item.value, item.value === null ? 'no_data' : 'ok')}</Text>}
              />
            </View>
          ))}
        </Card>
        {top.data?.comparedAtAgeDays ? <Text variant="caption">{t('insights.top.age', { days: top.data.comparedAtAgeDays })}</Text> : null}
        <SourceTag code={top.data?.source} testID="insights-top-source" />
      </Loadable>
      <Section title={t('insights.best.title')}>
        <Loadable query={best} testID="insights-best">
          <Card testID="insights-best-card">
            {best.data && !best.data.available ? (
              <Text variant="small" testID="insights-best-unavailable">{best.data.message ?? t('insights.figure.notAvailable')}</Text>
            ) : peak ? (
              <>
                <Text variant="title" testID="insights-best-peak">{t('insights.best.peak', { day: t(`insights.weekday.${WEEKDAYS[peak.weekday]}`), hour: formatHour(peak.hour) })}</Text>
                <Text variant="caption">{best.data.label} · {best.data.timeZone}</Text>
              </>
            ) : (
              <Text variant="small">{t('insights.figure.noData')}</Text>
            )}
          </Card>
        </Loadable>
      </Section>
    </Page>
  );
}

/**
 * The Bhava funnel per post (7.4): comments, DMs, seen, taps or visits, sales. A step Bhava can't measure for that
 * link says why, and is never estimated. Sales amounts are shown only to people who may see revenue.
 */
export function FunnelsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const { offline } = useConnection();
  const funnels = usePaged([...INSIGHTS_KEY, 'funnels'], (page) => api.insights.funnels(page));
  const items = itemsOf(funnels);
  return (
    <Page testID="screen-insights-funnels" offline={offline}>
      <Text variant="page">{t('insights.funnels.title')}</Text>
      <Loadable query={funnels} empty={!items.length} testID="insights-funnels" emptyTitle={t('insights.funnels.empty')}>
        <Card>
          {items.map((funnel, i) => {
            const sales = funnel.steps.find((s) => s.stage === 'sales');
            return (
              <View key={funnel.mediaId}>
                {i ? <Divider /> : null}
                <ListRow
                  testID={`insights-funnel-${funnel.mediaId}`}
                  title={t(`insights.kind.${funnel.kind}`)}
                  subtitle={`${t('insights.stage.sales')}: ${sales?.state === 'not_available' ? t('insights.figure.notAvailable') : figureText(t, sales?.count ?? null)}`}
                  onPress={() => navigation.navigate('insights.funnel', { id: funnel.mediaId })}
                />
              </View>
            );
          })}
        </Card>
        <MoreButton query={funnels} testID="insights-funnels-more" />
      </Loadable>
    </Page>
  );
}

export function FunnelScreen({ route }) {
  const { api } = useServices();
  const { t } = useStrings();
  const user = useUser();
  const { offline } = useConnection();
  const id = String(route?.params?.id ?? '');
  const funnel = useQuery({ queryKey: [...INSIGHTS_KEY, 'funnel', id], queryFn: () => api.insights.funnel(id), enabled: Boolean(id) });
  const data = funnel.data;
  return (
    <Page testID="screen-insights-funnel" offline={offline}>
      <Text variant="page">{t('insights.funnels.one')}</Text>
      <Loadable query={funnel} testID="insights-funnel">
        {data ? (
          <>
            <Card testID="insights-funnel-platform">
              <Text variant="title">{t('insights.funnels.platform')}</Text>
              <Text variant="small">{t('insights.metric.reach')}: {figureText(t, data.platform.reach)}</Text>
              <Text variant="small">{t('insights.metric.views')}: {figureText(t, data.platform.views)}</Text>
              <SourceTag code={data.platform.source} />
            </Card>
            <Card testID="insights-funnel-steps">
              {data.steps.map((step, i) => (
                <View key={step.stage} testID={`insights-step-${step.stage}`}>
                  {i ? <Divider /> : null}
                  <Text variant="small">{t(`insights.stage.${step.stage}`)}</Text>
                  {step.state === 'not_available' ? (
                    <Text variant="small" testID={`insights-step-${step.stage}-na`}>{`${t('insights.figure.notAvailable')}${step.reason ? `: ${step.reason}` : ''}`}</Text>
                  ) : (
                    <>
                      <Text variant="title" testID={`insights-step-${step.stage}-count`}>{figureText(t, step.count)}{step.lowVolume ? ` · ${t('insights.figure.lowVolume')}` : ''}</Text>
                      {step.stage === 'sales' && step.amountPaise !== null ? <Text variant="small" testID="insights-step-sales-amount">{moneyText(t, user, step.amountPaise)}</Text> : null}
                    </>
                  )}
                  <SourceTag code={step.source} />
                </View>
              ))}
            </Card>
            <Updated at={data.lastUpdatedAt} />
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}

const DESTINATIONS = ['amazon', 'affiliate'];

/**
 * Where sales outside the store are counted (7.15): connected destinations, the tag for the seller's own site, and
 * Amazon or affiliate report uploads. A report file is checked (5 MB, CSV) before it is sent.
 */
export function SourcesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const user = useUser();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const manager = isAllowed(user, MANAGERS);
  const [source, setSource] = useState('amazon');
  const [snippet, setSnippet] = useState(null);
  const [problem, setProblem] = useState(null);
  const connections = useQuery({ queryKey: [...INSIGHTS_KEY, 'destinations'], queryFn: () => api.destinations.connections() });
  const reports = useQuery({ queryKey: [...INSIGHTS_KEY, 'destinationReports'], queryFn: () => api.destinations.reports() });
  const siteTag = useMutation({
    mutationFn: (enabled) => api.destinations.setSiteTag({ enabled }),
    onSuccess: (answer) => {
      setSnippet(answer.snippet);
      queryClient.invalidateQueries({ queryKey: [...INSIGHTS_KEY, 'destinations'] });
    },
  });
  const upload = useMutation({
    mutationFn: async () => {
      const asset = await pickDocument(['text/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.ms-excel']);
      if (!asset) return null;
      const refused = fileProblem(asset, REPORT_RULE);
      if (refused) throw new UploadRefused(refused);
      return api.destinations.uploadReport(filePart(asset, REPORT_RULE), { source });
    },
    onMutate: () => setProblem(null),
    onError: (error) => setProblem(error),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...INSIGHTS_KEY, 'destinationReports'] }),
  });
  const items = connections.data?.items ?? [];
  const site = items.find((c) => c.source === 'site_tag');
  const rows = reports.data?.items ?? [];
  return (
    <Page testID="screen-insights-sources" offline={offline}>
      <Text variant="page">{t('insights.sources.title')}</Text>
      <Loadable query={connections} empty={!items.length} testID="insights-destinations" emptyTitle={t('insights.sources.empty')}>
        <Card>
          {items.map((c) => (
            <ListRow key={c.source} testID={`insights-destination-${c.source}`} title={t(`insights.destination.${c.source}`)} end={<Badge label={t(c.enabled ? 'insights.on' : 'insights.off')} tone={c.enabled ? 'good' : 'neutral'} />} />
          ))}
        </Card>
      </Loadable>
      {manager ? (
        <Card testID="insights-site-tag">
          <Toggle testID="insights-site-tag-toggle" title={t('insights.sources.siteTag')} subtitle={t('insights.sources.siteTagBody')} value={Boolean(site?.enabled)} disabled={!online || siteTag.isPending} onValueChange={(on) => siteTag.mutate(on)} />
          {snippet ? <Text variant="caption" selectable testID="insights-site-tag-snippet">{snippet}</Text> : null}
          <Refusal error={siteTag.error} testID="insights-site-tag-error" />
        </Card>
      ) : null}
      <Section title={t('insights.sources.uploads')}>
        {manager ? (
          <Card>
            <Choices testID="insights-upload-source" label={t('insights.sources.uploadFor')} value={source} onChange={setSource} options={DESTINATIONS.map((d) => ({ value: d, label: t(`insights.destination.${d}`) }))} />
            <Button testID="insights-upload" kind="secondary" label={t('insights.sources.upload')} busy={upload.isPending} disabled={!online} onPress={() => upload.mutate()} />
            <Text variant="caption">{t('insights.sources.uploadLimits')}</Text>
            <Refusal error={problem} testID="insights-upload-error" />
          </Card>
        ) : null}
        <Loadable query={reports} empty={!rows.length} testID="insights-uploads" emptyTitle={t('insights.sources.noUploads')}>
          <Card>
            {rows.map((row) => (
              <ListRow key={row.id} testID={`insights-upload-${row.id}`} title={t(`insights.destination.${row.source}`)} subtitle={t('insights.sources.uploadRow', { rows: row.rowsImported, unmatched: row.rowsUnmatched })} />
            ))}
          </Card>
        </Loadable>
      </Section>
    </Page>
  );
}
