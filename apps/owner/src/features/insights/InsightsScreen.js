import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { formatWhen, useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Choices, Section, Text } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { DaysChart, FigureTile, LinkRow, Loadable, Page, RangePicker, Refusal, SourceTag, TileRow, useConnection } from '../products/kit.js';
import { figureText, rangeQuery } from './figures.js';

export const INSIGHTS_KEY = ['insights'];

/** The account's insights state: connected, Permission needed, how fresh. Shared by every insights screen. */
export function useInsightsStatus() {
  const { api } = useServices();
  return useQuery({ queryKey: [...INSIGHTS_KEY, 'status'], queryFn: () => api.insights.status() });
}

/** The signed-in person, for the revenue rule. */
export const useUser = () => useSession().user;

/** The banner every insights screen shows above its figures: not connected, or Permission needed (7.1, 7.8). */
export function StatusBanner({ status }) {
  const { t } = useStrings();
  const openLink = useOpenLink();
  if (!status) return null;
  if (!status.connected) {
    return (
      <Banner testID="insights-not-connected" tone="warn" title={t('insights.notConnected.title')} action={<Button kind="secondary" label={t('insights.notConnected.action')} onPress={() => openLink('/connect')} />}>
        {t('insights.notConnected.body')}
      </Banner>
    );
  }
  if (status.permission === 'needed') {
    return (
      <Banner testID="insights-permission" tone="warn" title={t('insights.figure.permissionNeeded')} action={<Button kind="secondary" label={t('insights.permission.action')} onPress={() => openLink('/connect')} />}>
        {t('insights.permission.body')}
      </Banner>
    );
  }
  return null;
}

/** "Last updated 5 min ago" under a list, from the API's own time. */
export function Updated({ at, testID }) {
  const { t, locale } = useStrings();
  if (!at) return null;
  return <Text variant="caption" testID={testID}>{t('insights.updated', { when: formatWhen(t, at, { locale }) })}</Text>;
}

/**
 * Insights (PRD 7.1, 7.8): the account's figures over 7, 28 or 90 days from the server's cache, each chart naming its
 * source, and "Permission needed" or "Not available" in place of a number the API could not give. Refresh asks the
 * server to poll sooner, inside its own limits; the phone never calls Instagram.
 */
export default function InsightsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const { online, offline } = useConnection();
  const queryClient = useQueryClient();
  const [range, setRange] = useState('28');
  const status = useInsightsStatus();
  const account = useQuery({ queryKey: [...INSIGHTS_KEY, 'account', range], queryFn: () => api.insights.account(rangeQuery(range)) });
  const refresh = useMutation({
    mutationFn: () => api.insights.refresh(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY }),
  });
  const data = account.data;
  const metrics = data?.metrics ?? [];
  const permission = data?.permission ?? status.data?.permission ?? 'ok';
  const updated = data?.lastUpdatedAt ?? status.data?.lastUpdatedAt;

  return (
    <Page testID="screen-insights" offline={offline}>
      <Text variant="page">{t('insights.title')}</Text>
      <StatusBanner status={status.data} />
      <RangePicker value={range} onChange={setRange} />
      <Loadable query={account} empty={!metrics.length && !(data?.followers ?? []).length} testID="insights-account" emptyTitle={t('insights.empty')} emptyBody={t('insights.emptyBody')}>
        <TileRow testID="insights-totals">
          {metrics.map((m) => (
            <FigureTile
              key={m.metric}
              testID={`insights-total-${m.metric}`}
              label={m.label}
              text={permission === 'needed' ? t('insights.figure.permissionNeeded') : figureText(t, m.total, m.total === null ? 'not_available' : 'ok')}
              sub={m.estimated ? t('insights.estimated') : null}
            />
          ))}
        </TileRow>
        {metrics.map((m) => (
          <DaysChart key={m.metric} testID={`insights-chart-${m.metric}`} title={m.label} days={m.days} permission={permission} source={data.source} />
        ))}
        <DaysChart testID="insights-chart-followers" title={t('insights.followers')} days={data?.followers} permission={permission} source={data?.source} />
        {metrics.some((m) => m.days.some((d) => d.mayChange)) ? <Text variant="caption">{t('insights.mayChange')}</Text> : null}
      </Loadable>
      <Card>
        <Text variant="small" testID="insights-updated">{updated ? t('insights.updated', { when: formatWhen(t, updated, { locale }) }) : t('insights.neverUpdated')}</Text>
        {refresh.data ? <Text variant="small" testID="insights-refresh-message">{refresh.data.message}</Text> : null}
        <Button testID="insights-refresh" kind="secondary" label={t('insights.refresh')} busy={refresh.isPending} disabled={!online} onPress={() => refresh.mutate()} />
        <Refusal error={refresh.error} testID="insights-refresh-error" />
      </Card>
      <Section title={t('insights.more')}>
        <Card>
          <LinkRow testID="insights-open-audience" title={t('insights.audience.title')} onPress={() => navigation.navigate('insights.audience')} />
          <LinkRow testID="insights-open-content" title={t('insights.content.title')} onPress={() => navigation.navigate('insights.content')} />
          <LinkRow testID="insights-open-stories" title={t('insights.stories.title')} onPress={() => navigation.navigate('insights.stories')} />
          <LinkRow testID="insights-open-top" title={t('insights.top.title')} onPress={() => navigation.navigate('insights.top')} />
          <LinkRow testID="insights-open-funnels" title={t('insights.funnels.title')} onPress={() => navigation.navigate('insights.funnels')} />
          <LinkRow testID="insights-open-sources" title={t('insights.sources.title')} onPress={() => navigation.navigate('insights.sources')} />
        </Card>
      </Section>
    </Page>
  );
}

const BREAKDOWNS = ['age', 'gender', 'city', 'country'];
const FRAMES = ['this_week', 'this_month'];

/** Audience (7.1): who follows and who engages. Below 100 followers the API says so, and that sentence is shown, not an empty chart (N-02). */
export function AudienceScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const { offline } = useConnection();
  const [timeframe, setTimeframe] = useState('this_month');
  const audience = useQuery({ queryKey: [...INSIGHTS_KEY, 'audience', timeframe], queryFn: () => api.insights.audience({ timeframe }) });
  const data = audience.data;
  const groups = [...(data?.followers ?? []).map((g) => ({ ...g, who: 'followers' })), ...(data?.engaged ?? []).map((g) => ({ ...g, who: 'engaged' }))];
  return (
    <Page testID="screen-insights-audience" offline={offline}>
      <Text variant="page">{t('insights.audience.title')}</Text>
      <Choices testID="insights-audience-frame" label={t('insights.audience.title')} value={timeframe} onChange={setTimeframe} options={FRAMES.map((f) => ({ value: f, label: t(`insights.audience.frame.${f}`) }))} />
      <Loadable query={audience} empty={Boolean(data?.available) && groups.length === 0} testID="insights-audience" emptyTitle={t('insights.figure.noData')}>
        {data && !data.available ? (
          <Card testID="insights-audience-unavailable">
            <Text variant="title">{t('insights.figure.notAvailable')}</Text>
            <Text variant="small">{data.message}</Text>
          </Card>
        ) : (
          <>
            <SourceTag code={data?.source} testID="insights-audience-source" />
            {groups.map((group) => (
              <Card key={`${group.who}-${group.breakdown}`} testID={`insights-audience-${group.who}-${group.breakdown}`}>
                <Text variant="title">{t(`insights.audience.${group.who}`, { by: t(`insights.audience.by.${BREAKDOWNS.includes(group.breakdown) ? group.breakdown : 'other'}`) })}</Text>
                {[...group.items].sort((a, b) => b.value - a.value).slice(0, 8).map((item) => (
                  <View key={item.key} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text variant="small">{item.key}</Text>
                    <Text variant="small">{figureText(t, item.value)}</Text>
                  </View>
                ))}
              </Card>
            ))}
            <Updated at={data?.lastUpdatedAt} />
          </>
        )}
      </Loadable>
    </Page>
  );
}
