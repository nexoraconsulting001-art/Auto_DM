import React from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, errorKey, useStrings } from '@bhava/app-core';
import { MANAGERS, canSeeRevenue, isAllowed, staffWith } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Divider, EmptyState, ErrorState, ListRow, LoadingRows, ProgressRing, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { NothingSaved, StatusNotices, formatPaise, useWritable } from '../compliance/kit.js';
import { ActivityRow } from '../activity/ActivityScreen.js';
import { HEALTH_TONES, checklistView, firstName, needsYou, renewalDays } from './views.js';

export const HOME_KEY = ['home'];

/** One panel's answer: loading, nothing saved while offline, failed (with a retry), or drawn. A failure stays in its panel. */
function Panel({ query, testID, children }) {
  const { t } = useStrings();
  if (query.isPending && query.isPaused) return <NothingSaved testID={testID} />;
  if (query.isPending) return <LoadingRows rows={2} label={t('common.loading')} testID={`${testID}-loading`} />;
  if (query.error && query.data === undefined) {
    return <ErrorState testID={`${testID}-error`} title={t('error.title')} onRetry={() => query.refetch()} retryLabel={t('common.retry')}>{t(errorKey(query.error))}</ErrorState>;
  }
  return children(query.data);
}

/** The setup steps, for the owner and managers, until they are done or hidden (the console's checklist). */
function SetupPanel({ writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const queryClient = useQueryClient();
  const setup = useQuery({ queryKey: [...HOME_KEY, 'setup'], queryFn: () => api.settings.setup() });
  const hide = useMutation({
    mutationFn: () => api.settings.update({ checklistDismissed: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...HOME_KEY, 'setup'] }),
  });
  return (
    <Panel query={setup} testID="home-setup">
      {(status) => {
        const view = checklistView(status.checklist);
        return (
          <>
            {status.testMode ? <Banner testID="home-test-mode" tone="warn">{t('home.setup.testMode')}</Banner> : null}
            {!status.instagram.connected ? <Banner testID="home-no-instagram" tone="warn" action={<Button kind="secondary" label={t('home.setup.connect')} onPress={() => openLink('/connect')} />}>{t('home.setup.noInstagram')}</Banner> : null}
            {view.visible ? (
              <Card testID="home-checklist">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
                  <ProgressRing value={view.done} max={view.total} size={56} stroke={6} label={t('home.setup.progress', { done: view.done, total: view.total })}>
                    <Text variant="meta">{`${view.done}/${view.total}`}</Text>
                  </ProgressRing>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="title">{t('home.setup.title')}</Text>
                    <Text variant="small">{t('home.setup.progress', { done: view.done, total: view.total })}</Text>
                  </View>
                </View>
                {view.steps.map((step, i) => (
                  <View key={step.key}>
                    {i > 0 ? <Divider /> : null}
                    <ListRow
                      testID={`home-step-${step.key}`}
                      title={t(`home.step.${step.key}`)}
                      subtitle={step.done ? t('home.setup.done') : t(`home.step.${step.key}.text`)}
                      emphasis={step.next}
                      end={step.done ? <Badge label={t('home.setup.done')} tone="good" /> : null}
                      onPress={step.done || !step.path ? undefined : () => openLink(step.path)}
                    />
                  </View>
                ))}
                <Button testID="home-checklist-hide" kind="quiet" label={t('home.setup.hide')} busy={hide.isPending} disabled={!writable} onPress={() => hide.mutate()} />
                {hide.isError ? <Banner tone="bad" testID="home-checklist-refusal">{t(hide.error?.code === 'offline' ? 'offline.writeDisabled' : 'error.saveFailed')}</Banner> : null}
              </Card>
            ) : null}
          </>
        );
      }}
    </Panel>
  );
}

/** The safety score (PRD 7.7) and when the Instagram connection renews: the line the mock-up puts under the score. */
function SafetyPanel({ showConnection }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const health = useQuery({ queryKey: [...HOME_KEY, 'health'], queryFn: () => api.accountHealth.get() });
  // A connection that cannot be read (a demo account, Instagram down) hides this one line and nothing else (P-25).
  const connection = useQuery({ queryKey: ['connect', 'instagram'], queryFn: () => api.instagram.connection(), enabled: showConnection, retry: false });
  const days = renewalDays(connection.data);
  return (
    <Section title={t('home.safety.title')} action={<Button testID="home-safety-details" kind="quiet" label={t('home.details')} onPress={() => openLink('/account-health')} />}>
      <Card testID="home-safety">
        <Panel query={health} testID="home-health">
          {(score) => (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
                <ProgressRing testID="home-score" value={score.score ?? 0} label={score.score === null ? t('home.safety.unscored') : t('home.safety.scoreLabel', { score: score.score })}>
                  <Text variant="title">{score.score === null ? '–' : String(score.score)}</Text>
                </ProgressRing>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="title" testID="home-band">{t(score.band ? `home.band.${score.band}` : 'home.safety.unscored')}</Text>
                  <Text variant="small">{t(score.band ? `home.band.${score.band}.text` : 'home.safety.unscoredText')}</Text>
                </View>
                {score.band ? <Badge label={String(score.score)} tone={HEALTH_TONES[score.band] ?? 'neutral'} /> : null}
              </View>
              {score.deductions.slice(0, 3).map((deduction) => (
                <View key={deduction.code} testID={`home-deduction-${deduction.code}`} style={{ gap: 2 }}>
                  <Text variant="small">{deduction.message}</Text>
                  {deduction.fix ? <Text variant="meta">{deduction.fix}</Text> : null}
                </View>
              ))}
            </>
          )}
        </Panel>
        {days !== null ? (
          <ListRow
            testID="home-renews"
            title={t(days === 1 ? 'home.safety.renewsDay' : 'home.safety.renewsDays', { days })}
            end={<Button kind="quiet" label={t('home.details')} onPress={() => openLink('/connect')} />}
          />
        ) : null}
      </Card>
    </Section>
  );
}

function Tile({ value, label, sub, highlight, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ flexBasis: '47%', flexGrow: 1, gap: 2, padding: theme.space[3], borderRadius: theme.radius.tile, backgroundColor: highlight ? theme.color.accent : theme.color.inkRaised }}>
      <Text variant="title" style={{ color: highlight ? theme.color.ink : theme.color.onInk }}>{value}</Text>
      <Text variant="meta" style={{ color: highlight ? theme.color.ink : theme.color.onInk2 }}>{label}</Text>
      {sub ? <Text variant="caption" style={{ color: highlight ? theme.color.ink : theme.color.onInk2 }}>{sub}</Text> : null}
    </View>
  );
}

/** Today's numbers and the totals behind them, and what needs the seller now. Revenue only for those who may see it. */
function NumbersPanel({ user, showInbox }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const stats = useQuery({ queryKey: [...HOME_KEY, 'stats'], queryFn: () => api.stats.dashboard() });
  const waiting = useQuery({ queryKey: [...HOME_KEY, 'needs-human'], queryFn: () => api.inbox.needsHuman({ status: 'open', limit: 20 }), enabled: showInbox, retry: false });
  const count = (n) => Number(n ?? 0).toLocaleString('en-IN');
  return (
    <Panel query={stats} testID="home-stats">
      {(numbers) => {
        const items = needsYou({ stats: numbers, waiting: showInbox ? waiting.data : null, user });
        return (
          <>
            <Card testID="home-numbers" style={{ backgroundColor: theme.color.ink, borderColor: theme.color.ink }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text variant="title" style={{ flex: 1, color: theme.color.onInk }}>{t('home.numbers.title')}</Text>
                <Text variant="meta" style={{ color: theme.color.onInk2 }}>{t('home.numbers.today')}</Text>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
                <Tile testID="home-dms" value={count(numbers.dmsToday)} label={t('home.numbers.dms')} sub={t('home.numbers.allTime', { count: count(numbers.dms) })} />
                <Tile testID="home-visits" value={count(numbers.visitsToday)} label={t('home.numbers.visits')} sub={t('home.numbers.allTime', { count: count(numbers.visits) })} />
                <Tile testID="home-orders" value={count(numbers.ordersToday)} label={t('home.numbers.orders')} sub={t('home.numbers.allTime', { count: count(numbers.orders) })} highlight={!canSeeRevenue(user)} />
                {canSeeRevenue(user) ? <Tile testID="home-revenue" value={formatPaise(numbers.revenuePaise)} label={t('home.numbers.revenue')} sub={t('home.numbers.revenueSub')} highlight /> : null}
              </View>
            </Card>
            {items.length ? (
              <Section title={t('home.needs.title')} action={<Badge testID="home-needs-count" label={items.length} tone="primary" />}>
                {items.map((item) => (
                  <Card key={item.key} testID={`home-needs-${item.key}`}>
                    <Text variant="title">{t(item.title, item.values)}</Text>
                    <Text variant="small">{t(item.body)}</Text>
                    <Button kind="secondary" label={t(item.cta)} onPress={() => openLink(item.path)} />
                  </Card>
                ))}
              </Section>
            ) : null}
          </>
        );
      }}
    </Panel>
  );
}

function ReelsPanel() {
  const { api } = useServices();
  const { t } = useStrings();
  const openLink = useOpenLink();
  const reels = useQuery({ queryKey: [...HOME_KEY, 'reels'], queryFn: () => api.reels.list({ limit: 5 }) });
  return (
    <Section title={t('home.reels.title')} action={<Button testID="home-reels-all" kind="quiet" label={t('home.seeAll')} onPress={() => openLink('/reels')} />}>
      <Card>
        <Panel query={reels} testID="home-reels">
          {({ items }) => (items.length ? items.map((reel, i) => (
            <View key={reel.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`home-reel-${reel.id}`}
                title={reel.headline || reel.slug}
                subtitle={t('home.reels.line', { products: reel.productCount, dms: reel.dmCount, orders: reel.orderCount })}
                end={<Badge label={t(reel.active ? 'home.reels.live' : 'home.reels.paused')} tone={reel.active ? 'good' : 'neutral'} />}
                onPress={() => openLink(`/reels/${reel.id}`)}
              />
            </View>
          )) : <EmptyState testID="home-reels-empty" title={t('home.reels.empty')} action={<Button kind="secondary" label={t('home.reels.setUp')} onPress={() => openLink('/reels')} />} />)}
        </Panel>
      </Card>
    </Section>
  );
}

function CommentsPanel() {
  const { api } = useServices();
  const { t } = useStrings();
  const openLink = useOpenLink();
  const activity = useQuery({ queryKey: [...HOME_KEY, 'activity'], queryFn: () => api.activity.list({ limit: 5 }) });
  return (
    <Section title={t('home.comments.title')} action={<Button testID="home-activity-all" kind="quiet" label={t('home.seeAll')} onPress={() => openLink('/activity')} />}>
      <Card>
        <Panel query={activity} testID="home-activity">
          {({ items }) => (items.length ? items.map((row, i) => (
            <View key={row.id}>
              {i > 0 ? <Divider /> : null}
              <ActivityRow row={row} compact />
            </View>
          )) : <EmptyState testID="home-activity-empty" title={t('home.comments.empty')}>{t('home.comments.emptyBody')}</EmptyState>)}
        </Panel>
      </Card>
    </Section>
  );
}

/**
 * Home (the console's dashboard, m-Home): the safety score, today's numbers, what needs the seller now, and the latest
 * reels and comments. Each panel is shown only to someone the API would answer, loads on its own, and fails on its own,
 * so one refusal or a missing connection never takes the screen down. The business appears only as the workspace name.
 */
export default function HomeScreen() {
  const { t } = useStrings();
  const { user } = useSession();
  const openLink = useOpenLink();
  const writable = useWritable();
  const theme = useTheme();
  const may = (access) => isAllowed(user, access);
  const automations = may(staffWith('automations'));
  const analytics = may(staffWith('analytics'));
  const inbox = may(staffWith('inbox'));
  const managers = may(MANAGERS);
  const nothing = !automations && !analytics && !inbox && !managers;
  return (
    <Screen testID="screen-home" title={t('home.hello', { name: firstName(user?.name) })}>
      <OfflineBanner offline={!writable} />
      <StatusNotices allowed={automations} />
      {managers ? <SetupPanel writable={writable} /> : null}
      {analytics ? <SafetyPanel showConnection={automations} /> : null}
      {analytics ? <NumbersPanel user={user} showInbox={inbox} /> : null}
      {!analytics && inbox ? <Button testID="home-open-needs-human" kind="secondary" label={t('home.needs.openInbox')} onPress={() => openLink('/inbox/needs-human')} /> : null}
      {automations ? <ReelsPanel /> : null}
      {automations ? <CommentsPanel /> : null}
      {automations ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          <Button testID="home-new-automation" kind="secondary" label={t('home.newAutomation')} onPress={() => openLink('/automations/new')} />
        </View>
      ) : null}
      {nothing ? <EmptyState testID="home-empty" title={t('home.empty')}>{t('home.emptyBody')}</EmptyState> : null}
    </Screen>
  );
}
