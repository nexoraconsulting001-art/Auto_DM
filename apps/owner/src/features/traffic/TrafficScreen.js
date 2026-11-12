import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { useReauth, useStrings } from '@bhava/app-core';
import { OWNER_ONLY, isAllowed } from '@bhava/app-core/access';
import { Badge, Button, Card, Choices, Divider, Field, ListRow, Section, Sparkline, Text, Toggle } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { FigureTile, LinkRow, Loadable, Page, RangePicker, Refusal, SourceTag, TileRow, useConnection } from '../products/kit.js';
import { busiest, figureText, formatCount, formatDuration, formatHour, formatRate, moneyText, rangeQuery, showsRevenue } from '../insights/figures.js';

export const TRAFFIC_KEY = ['traffic'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const BREAKDOWNS = ['device', 'city', 'in_app', 'visitor_type', 'utm_campaign'];

/** The words for a traffic source code, or the code itself for one the app doesn't know yet. */
export const sourceWords = (t, code) => {
  const text = t(`traffic.source.${code}`);
  return text === `traffic.source.${code}` ? String(code).replace(/_/g, ' ') : text;
};

/** One Delta (the contract's) as a tile's text: the number, or "Not available" when the plan or the role leaves it out. */
function deltaText(t, summary, name, format = formatCount) {
  if (summary.notIncluded.includes(name)) return t('insights.figure.notAvailable');
  return figureText(t, summary[name]?.value ?? null, 'ok', format);
}

/**
 * Traffic (PRD 7.10): visits to the business's own pages, measured by Bhava, as in Traffic.dc.html and the traffic
 * half of m-Insights.dc.html: sessions over time, who is on now, where they come from, when, and on what. Aggregates
 * only: nothing here can name one visitor. Revenue shows only for people canSeeRevenue allows.
 */
export default function TrafficScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const navigation = useNavigation();
  const { offline } = useConnection();
  const [range, setRange] = useState('28');
  const [by, setBy] = useState('device');
  const query = { ...rangeQuery(range), compare: 'previous' };
  const money = showsRevenue(user);
  const summary = useQuery({ queryKey: [...TRAFFIC_KEY, 'summary', range], queryFn: () => api.traffic.summary(query) });
  const trend = useQuery({ queryKey: [...TRAFFIC_KEY, 'trend', range], queryFn: () => api.traffic.trend(query) });
  const live = useQuery({ queryKey: [...TRAFFIC_KEY, 'realtime'], queryFn: () => api.traffic.realtime(), refetchInterval: 15_000 });
  const sources = useQuery({ queryKey: [...TRAFFIC_KEY, 'sources', range], queryFn: () => api.traffic.sources(query) });
  const heatmap = useQuery({ queryKey: [...TRAFFIC_KEY, 'heatmap', range], queryFn: () => api.traffic.heatmap(query) });
  const pages = useQuery({ queryKey: [...TRAFFIC_KEY, 'pages', range], queryFn: () => api.traffic.pages(query) });
  const breakdown = useQuery({ queryKey: [...TRAFFIC_KEY, 'breakdown', range, by], queryFn: () => api.traffic.breakdown({ ...query, by }) });
  const s = summary.data;
  const points = trend.data?.points ?? [];
  const peak = busiest(heatmap.data?.cells);
  const sourceRows = sources.data?.items ?? [];
  const pageRows = pages.data?.items ?? [];
  const breakdownRows = breakdown.data?.items ?? [];

  return (
    <Page testID="screen-traffic" offline={offline}>
      <Text variant="page">{t('traffic.title')}</Text>
      <RangePicker value={range} onChange={setRange} />
      <Loadable query={summary} testID="traffic-summary">
        {s ? (
          <>
            <TileRow testID="traffic-tiles">
              <FigureTile testID="traffic-sessions" label={t('traffic.sessions')} text={deltaText(t, s, 'sessions')} delta={s.sessions} />
              <FigureTile testID="traffic-visitors" label={t('traffic.visitors')} text={deltaText(t, s, 'visitors')} delta={s.visitors} />
              <FigureTile testID="traffic-taps" label={t('traffic.productTaps')} text={deltaText(t, s, 'productTaps')} delta={s.productTaps} />
              <FigureTile testID="traffic-whatsapp" label={t('traffic.whatsappTaps')} text={deltaText(t, s, 'whatsappTaps')} delta={s.whatsappTaps} />
              <FigureTile testID="traffic-orders" label={t('traffic.orders')} text={deltaText(t, s, 'orders')} delta={s.orders} />
              {money ? (
                <FigureTile testID="traffic-revenue" label={t('traffic.revenue')} text={s.notIncluded.includes('revenuePaise') ? t('insights.figure.notAvailable') : moneyText(t, user, s.revenuePaise?.value ?? null)} delta={s.revenuePaise} />
              ) : null}
              <FigureTile testID="traffic-bounce" label={t('traffic.bounce')} text={deltaText(t, s, 'bounceRate', (v) => formatRate(v, 0))} />
              <FigureTile testID="traffic-engaged" label={t('traffic.engaged')} text={deltaText(t, s, 'medianEngagedMs', formatDuration)} />
            </TileRow>
            <SourceTag code={s.source} testID="traffic-summary-source" />
            {s.previews ? <Text variant="caption">{t('traffic.previews', { count: formatCount(s.previews) })}</Text> : null}
          </>
        ) : null}
      </Loadable>
      <Card testID="traffic-trend">
        <Text variant="title">{t('traffic.trend')}</Text>
        {live.data ? <Badge testID="traffic-live" tone="good" label={t('traffic.liveNow', { count: formatCount(live.data.active) })} /> : null}
        {trend.isPending ? <Text variant="small">{t('common.loading')}</Text> : points.length >= 2 ? (
          <Sparkline testID="traffic-trend-line" values={points.map((p) => p.sessions)} label={t('insights.chartLabel', { title: t('traffic.trend'), values: points.map((p) => p.sessions).join(', ') })} />
        ) : (
          <Text variant="small" testID="traffic-trend-state">{t(trend.error ? 'error.title' : 'insights.figure.noData')}</Text>
        )}
        <SourceTag code={trend.data?.label} testID="traffic-trend-source" />
      </Card>
      <Section title={t('traffic.where')}>
        <Loadable query={sources} empty={!sourceRows.length} testID="traffic-sources" emptyTitle={t('traffic.none')}>
          <Card>
            {sourceRows.map((row, i) => (
              <View key={`${row.source}-${row.referrerDomain}`}>
                {i ? <Divider /> : null}
                <ListRow
                  testID={`traffic-source-${row.source}`}
                  title={sourceWords(t, row.source)}
                  subtitle={[
                    t('traffic.row.sessions', { count: formatCount(row.sessions) }),
                    t('traffic.row.orders', { count: figureText(t, row.orders) }),
                    money ? moneyText(t, user, row.revenuePaise) : null,
                  ].filter(Boolean).join(' · ')}
                />
              </View>
            ))}
          </Card>
          <SourceTag code={sources.data?.label} testID="traffic-sources-source" />
        </Loadable>
      </Section>
      <Section title={t('traffic.when')}>
        <Loadable query={heatmap} testID="traffic-heatmap">
          <Card>
            <Text variant="body" testID="traffic-busiest">{peak ? t('traffic.busiest', { day: t(`insights.weekday.${WEEKDAYS[peak.weekday]}`), hour: formatHour(peak.hour) }) : t('insights.figure.noData')}</Text>
            <SourceTag code={heatmap.data?.label} />
          </Card>
        </Loadable>
      </Section>
      <Section title={t('traffic.audience')}>
        <Choices testID="traffic-by" label={t('traffic.audience')} value={by} onChange={setBy} options={BREAKDOWNS.map((b) => ({ value: b, label: t(`traffic.by.${b}`) }))} />
        <Loadable query={breakdown} empty={!breakdownRows.length} testID="traffic-breakdown" emptyTitle={t('traffic.none')}>
          <Card>
            {breakdownRows.slice(0, 10).map((row) => (
              <View key={row.key} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="small">{row.key || t('traffic.unknown')}</Text>
                <Text variant="small">{formatCount(row.sessions)}</Text>
              </View>
            ))}
            <SourceTag code={breakdown.data?.label} />
          </Card>
        </Loadable>
      </Section>
      <Section title={t('traffic.pages')}>
        <Loadable query={pages} empty={!pageRows.length} testID="traffic-pages" emptyTitle={t('traffic.none')}>
          <Card>
            {pageRows.slice(0, 10).map((row) => (
              <ListRow key={`${row.kind}-${row.ref}`} title={row.title || row.ref} subtitle={t('traffic.row.views', { count: formatCount(row.views), taps: formatCount(row.taps) })} />
            ))}
            <SourceTag code={pages.data?.label} />
          </Card>
        </Loadable>
      </Section>
      <Section title={t('traffic.dig')}>
        <Card>
          <LinkRow testID="traffic-open-explore" title={t('traffic.explore.title')} onPress={() => navigation.navigate('traffic.explore')} />
          <LinkRow testID="traffic-open-funnels" title={t('traffic.funnels.title')} onPress={() => navigation.navigate('traffic.funnels')} />
          <LinkRow testID="traffic-open-cohorts" title={t('traffic.cohorts.title')} onPress={() => navigation.navigate('traffic.cohorts')} />
          {isAllowed(user, OWNER_ONLY) ? <LinkRow testID="traffic-open-tags" title={t('traffic.tags.title')} onPress={() => navigation.navigate('traffic.tags')} /> : null}
        </Card>
      </Section>
    </Page>
  );
}

/**
 * Pixels and analytics tags (7.14), owner only. Tokens and secrets are write-only: the screen says whether one is
 * set and never shows it back. Saving needs a fresh check (sign-in or re-auth in the last five minutes).
 */
export function TagsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const { runFresh } = useReauth();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const tags = useQuery({ queryKey: [...TRAFFIC_KEY, 'tags'], queryFn: () => api.tags.get() });
  const health = useQuery({ queryKey: [...TRAFFIC_KEY, 'tagHealth'], queryFn: () => api.tags.health() });
  const [form, setForm] = useState({ pixelId: null, capiToken: '', measurementId: null, apiSecret: '' });
  const save = useMutation({
    mutationFn: (body) => runFresh(() => api.tags.update(body)),
    onSuccess: (answer) => {
      queryClient.setQueryData([...TRAFFIC_KEY, 'tags'], answer);
      setForm({ pixelId: null, capiToken: '', measurementId: null, apiSecret: '' });
    },
  });
  const data = tags.data;
  const body = (part) => {
    const out = {};
    if (part === 'meta') {
      out.meta = {};
      if (form.pixelId !== null) out.meta.pixelId = form.pixelId.trim();
      if (form.capiToken.trim()) out.meta.capiToken = form.capiToken.trim();
    } else {
      out.ga4 = {};
      if (form.measurementId !== null) out.ga4.measurementId = form.measurementId.trim();
      if (form.apiSecret.trim()) out.ga4.apiSecret = form.apiSecret.trim();
    }
    return out;
  };
  return (
    <Page testID="screen-traffic-tags" offline={offline}>
      <Text variant="page">{t('traffic.tags.title')}</Text>
      <Loadable query={tags} testID="traffic-tags">
        {data && !data.available ? <Text variant="small" testID="traffic-tags-unavailable">{t('traffic.tags.unavailable')}</Text> : null}
        {data && data.available ? (
          <>
            {!data.consentReady ? <Text variant="small" testID="traffic-tags-consent">{t('traffic.tags.consent')}</Text> : null}
            <Card testID="traffic-tags-meta">
              <Toggle testID="traffic-tags-meta-on" title={t('traffic.tags.meta')} value={data.meta.enabled} disabled={!online || save.isPending} onValueChange={(on) => save.mutate({ meta: { enabled: on } })} />
              <Field testID="traffic-tags-pixel" label={t('traffic.tags.pixelId')} value={form.pixelId ?? data.meta.pixelId} onChangeText={(v) => setForm({ ...form, pixelId: v })} keyboardType="number-pad" editable={online} />
              <Field testID="traffic-tags-capi" label={t('traffic.tags.capiToken')} hint={t(data.meta.capiTokenSet ? 'traffic.tags.secretSet' : 'traffic.tags.secretNotSet')} value={form.capiToken} onChangeText={(v) => setForm({ ...form, capiToken: v })} secret editable={online} />
              <Button testID="traffic-tags-meta-save" label={t('common.save')} busy={save.isPending} disabled={!online} onPress={() => save.mutate(body('meta'))} />
            </Card>
            <Card testID="traffic-tags-ga4">
              <Toggle testID="traffic-tags-ga4-on" title={t('traffic.tags.ga4')} value={data.ga4.enabled} disabled={!online || save.isPending} onValueChange={(on) => save.mutate({ ga4: { enabled: on } })} />
              <Field testID="traffic-tags-measurement" label={t('traffic.tags.measurementId')} value={form.measurementId ?? data.ga4.measurementId} onChangeText={(v) => setForm({ ...form, measurementId: v })} autoCapitalize="characters" editable={online} />
              <Field testID="traffic-tags-secret" label={t('traffic.tags.apiSecret')} hint={t(data.ga4.apiSecretSet ? 'traffic.tags.secretSet' : 'traffic.tags.secretNotSet')} value={form.apiSecret} onChangeText={(v) => setForm({ ...form, apiSecret: v })} secret editable={online} />
              <Button testID="traffic-tags-ga4-save" label={t('common.save')} busy={save.isPending} disabled={!online} onPress={() => save.mutate(body('ga4'))} />
            </Card>
            <Refusal error={save.error} testID="traffic-tags-error" />
          </>
        ) : null}
      </Loadable>
      <Section title={t('traffic.tags.health')}>
        <Loadable query={health} empty={!(health.data?.items ?? []).length} testID="traffic-tag-health" emptyTitle={t('traffic.none')}>
          <Card>
            {(health.data?.items ?? []).map((row) => (
              <ListRow key={row.provider} testID={`traffic-tag-health-${row.provider}`} title={t(`traffic.tags.${row.provider}`)} subtitle={t('traffic.tags.healthRow', { sent: formatCount(row.sent), failed: formatCount(row.failed) })} end={row.failedDaysInARow ? <Badge tone="bad" label={t('traffic.tags.failing')} /> : null} />
            ))}
          </Card>
        </Loadable>
      </Section>
    </Page>
  );
}
