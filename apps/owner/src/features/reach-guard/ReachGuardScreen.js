import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { formatDate, formatWhen, useStrings } from '@bhava/app-core';
import { OWNER_ONLY, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Divider, Field, ListRow, ProgressRing, Section, Text } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { DaysChart, LinkRow, Loadable, Page, RangePicker, Refusal, SourceTag, useConnection } from '../products/kit.js';
import { figureText, formatPercent, rangeQuery } from '../insights/figures.js';

export const REACH_KEY = ['reach-guard'];
const STATE_TONES = { learning: 'neutral', normal: 'good', watch: 'warn', tripped: 'bad', permission_needed: 'warn' };
const BAND_TONES = { good: 'good', watch: 'warn', at_risk: 'bad' };
const THRESHOLDS = ['reachDropPercent', 'mediaDropPercent', 'clearPercent'];

/**
 * Reach Guard (PRD 7.6): whether reach has dropped against the account's usual, in the server's own words (it never
 * says "shadowbanned" or "safe"), slow mode, the owner's thresholds and every past trip. Overriding slow mode lives
 * on the compliance screen, with its typed confirmation; this screen opens it.
 */
export default function ReachGuardScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const openLink = useOpenLink();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const owner = isAllowed(user, OWNER_ONLY);
  const status = useQuery({ queryKey: [...REACH_KEY, 'status'], queryFn: () => api.reachGuard.status() });
  const trips = useQuery({ queryKey: [...REACH_KEY, 'trips'], queryFn: () => api.reachGuard.trips() });
  const [draft, setDraft] = useState(null);
  const data = status.data;
  useEffect(() => {
    if (data?.thresholds && draft === null) setDraft(Object.fromEntries(THRESHOLDS.map((k) => [k, String(data.thresholds[k])])));
  }, [data, draft]);
  const save = useMutation({
    mutationFn: (body) => api.reachGuard.setThresholds(body),
    onSuccess: (answer) => {
      queryClient.setQueryData([...REACH_KEY, 'status'], answer);
      setDraft(Object.fromEntries(THRESHOLDS.map((k) => [k, String(answer.thresholds[k])])));
    },
  });
  const typed = draft ? Object.fromEntries(THRESHOLDS.map((k) => [k, Number(draft[k])])) : null;
  const bad = typed ? THRESHOLDS.filter((k) => !/^\d{1,3}$/.test(String(draft[k]).trim())) : [];
  const tripList = trips.data?.items ?? [];

  return (
    <Page testID="screen-reach-guard" offline={offline}>
      <Text variant="page">{t('reach-guard.title')}</Text>
      <Loadable query={status} testID="reach-status">
        {data ? (
          <>
            <Card testID="reach-state">
              <Badge testID="reach-state-badge" label={t(`reach-guard.state.${data.state}`)} tone={STATE_TONES[data.state] ?? 'neutral'} />
              <Text variant="body" testID="reach-message">{data.message}</Text>
              <Text variant="small">
                {t('reach-guard.baseline', { reach: data.baselineReach === null ? t('insights.figure.notAvailable') : figureText(t, data.baselineReach), days: data.settledDays, posts: data.mediaCounted })}
              </Text>
              {data.lastEvaluatedAt ? <Text variant="caption">{t('reach-guard.checked', { when: formatWhen(t, data.lastEvaluatedAt, { locale }) })}</Text> : null}
              <SourceTag code="platform" />
            </Card>
            {data.slowMode.active ? (
              <Banner testID="reach-slow-mode" tone="warn" title={t('reach-guard.slow.title')} action={<Button kind="secondary" label={t('reach-guard.slow.open')} onPress={() => openLink('/compliance')} />}>
                {[t(`reach-guard.slow.why.${data.slowMode.trigger ?? 'reach_drop'}`), data.slowMode.until ? t('reach-guard.slow.until', { date: formatDate(data.slowMode.until, { locale }) }) : null, data.slowMode.restoring ? t('reach-guard.slow.restoring') : null].filter(Boolean).join(' ')}
              </Banner>
            ) : null}
            <Section title={t('reach-guard.thresholds')}>
              <Card testID="reach-thresholds">
                {THRESHOLDS.map((k) => (
                  <Field
                    key={k}
                    testID={`reach-threshold-${k}`}
                    label={t(`reach-guard.threshold.${k}`)}
                    value={draft?.[k] ?? ''}
                    onChangeText={(v) => setDraft({ ...draft, [k]: v })}
                    keyboardType="number-pad"
                    editable={owner && online}
                    error={save.error?.fields?.[k] ?? (bad.includes(k) ? t('reach-guard.wholeNumber') : undefined)}
                  />
                ))}
                {owner ? (
                  <Button testID="reach-thresholds-save" label={t('reach-guard.save')} busy={save.isPending} disabled={!online || bad.length > 0 || !typed} onPress={() => save.mutate(typed)} />
                ) : (
                  <Text variant="caption" testID="reach-thresholds-owner-only">{t('reach-guard.ownerOnly')}</Text>
                )}
                <Refusal error={save.error} testID="reach-thresholds-error" />
              </Card>
            </Section>
          </>
        ) : null}
      </Loadable>
      <Section title={t('reach-guard.trips')}>
        <Loadable query={trips} empty={!tripList.length} testID="reach-trips" emptyTitle={t('reach-guard.noTrips')}>
          <Card>
            {tripList.map((trip, i) => (
              <View key={trip.id}>
                {i ? <Divider /> : null}
                <ListRow
                  testID={`reach-trip-${trip.id}`}
                  title={t(`reach-guard.trigger.${trip.trigger}`)}
                  subtitle={[
                    formatDate(trip.startedAt, { locale }),
                    trip.dropPercent === null ? null : t('reach-guard.drop', { percent: formatPercent(trip.dropPercent) }),
                    trip.clearedAt ? t('reach-guard.cleared', { date: formatDate(trip.clearedAt, { locale }) }) : t('reach-guard.ongoing'),
                  ].filter(Boolean).join(' · ')}
                />
              </View>
            ))}
          </Card>
        </Loadable>
      </Section>
      <Card>
        <LinkRow testID="reach-open-health" title={t('reach-guard.health.title')} onPress={() => navigation.navigate('reach-guard.health')} />
      </Card>
    </Page>
  );
}

/** Account Health (7.7): a score out of 100 with its band, each deduction with how to fix it, and its history. */
export function AccountHealthScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const { offline } = useConnection();
  const [range, setRange] = useState('28');
  const health = useQuery({ queryKey: [...REACH_KEY, 'health'], queryFn: () => api.accountHealth.get() });
  const history = useQuery({ queryKey: [...REACH_KEY, 'healthHistory', range], queryFn: () => api.accountHealth.history(rangeQuery(range)) });
  const data = health.data;
  return (
    <Page testID="screen-account-health" offline={offline}>
      <Text variant="page">{t('reach-guard.health.title')}</Text>
      <Loadable query={health} testID="health">
        {data ? (
          <Card testID="health-score">
            {data.score === null ? (
              <Text variant="title" testID="health-score-none">{t('insights.figure.notAvailable')}</Text>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <ProgressRing testID="health-ring" value={data.score} label={t('reach-guard.health.scoreLabel', { score: data.score })} />
                {data.band ? <Badge testID="health-band" label={t(`reach-guard.band.${data.band}`)} tone={BAND_TONES[data.band]} /> : null}
              </View>
            )}
            {data.computedAt ? <Text variant="caption">{t('insights.updated', { when: formatWhen(t, data.computedAt, { locale }) })}</Text> : null}
            <SourceTag code="bhava" />
          </Card>
        ) : null}
        {data && data.deductions.length ? (
          <Section title={t('reach-guard.health.deductions')}>
            <Card>
              {data.deductions.map((d, i) => (
                <View key={d.code} testID={`health-deduction-${d.code}`} style={{ gap: 2 }}>
                  {i ? <Divider /> : null}
                  <Text variant="body">{d.message}</Text>
                  <Text variant="small">{t('reach-guard.health.points', { points: Math.abs(d.points) })}</Text>
                  {d.fix ? <Text variant="small" tone="primary">{d.fix}</Text> : null}
                </View>
              ))}
            </Card>
          </Section>
        ) : data ? <Text variant="small" testID="health-no-deductions">{t('reach-guard.health.none')}</Text> : null}
      </Loadable>
      <RangePicker value={range} onChange={setRange} testID="health-range" />
      <Loadable query={history} testID="health-history">
        <DaysChart testID="health-chart" title={t('reach-guard.health.history')} days={history.data?.days} source="bhava" />
      </Loadable>
    </Page>
  );
}
