import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { MANAGERS, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, ConfirmSheet, Divider, Field, ListRow, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { NoticeList, PagedState, RecordState, Refusal, formatDateTime, usePaged, useStatusSources, useWritable } from './kit.js';
import { GATES, overallStatus, overrideTyped, statusNotices } from './notices.js';
import { describeKind, describeReason } from './reasons.js';

/** A change to the status: the answer is the new status, and everything that lists held messages reads again. */
function useStatusChange(fn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (status) => {
      if (status) queryClient.setQueryData(['compliance', 'status'], status);
      await queryClient.invalidateQueries({ queryKey: ['compliance'] });
    },
  });
}

function StatusHero({ status }) {
  const { t } = useStrings();
  const theme = useTheme();
  const { title, tone, badge } = overallStatus(status);
  return (
    <Card testID="compliance-hero" style={{ backgroundColor: theme.color.ink, borderColor: theme.color.ink }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        <Text variant="title" tone="onInk" style={{ flex: 1 }}>{t(title)}</Text>
        <Badge testID="compliance-badge" label={t(badge)} tone={tone} />
      </View>
      <Text variant="small" style={{ color: theme.color.onInk2 }}>
        {status.heldJobs > 0 ? t(status.heldJobs === 1 ? 'compliance.heldOne' : 'compliance.heldMany', { count: status.heldJobs }) : t('compliance.heldNone')}
      </Text>
    </Card>
  );
}

/** The seller's own kill switch. A pause by support shows here, and only support can lift it (PRD 4.12). */
function PausePanel({ status, canManage, writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const [pauseStore, setPauseStore] = useState(false);
  const [asking, setAsking] = useState(false);
  const pause = useStatusChange(() => api.compliance.pause({ pauseStore }));
  const resume = useStatusChange(() => api.compliance.resume());
  const error = pause.error ?? resume.error;

  let body;
  if (status.paused && !status.canResume) body = <Text variant="small" testID="compliance-support-pause">{t('compliance.notice.supportPause')}</Text>;
  else if (!canManage) body = <Text variant="small" testID="compliance-managers-only">{`${status.paused ? t('compliance.pause.stopped') : ''}${t('compliance.pause.managersOnly')}`}</Text>;
  else if (status.paused) {
    body = (
      <>
        <Text variant="small">{t(status.pauseStore ? 'compliance.pause.storeClosed' : 'compliance.pause.storeOpen')}</Text>
        <Button testID="compliance-resume" label={t('compliance.pause.resume')} busy={resume.isPending} disabled={!writable} onPress={() => resume.mutate()} />
      </>
    );
  } else {
    body = (
      <>
        <Text variant="small">{t('compliance.pause.explain')}</Text>
        <Toggle testID="compliance-pause-store" title={t('compliance.pause.alsoStore')} value={pauseStore} onValueChange={setPauseStore} disabled={!writable} />
        <Button testID="compliance-pause" kind="danger" label={t('compliance.pause.action')} busy={pause.isPending} disabled={!writable} onPress={() => setAsking(true)} />
      </>
    );
  }
  return (
    <Section title={t('compliance.pause.title')}>
      <Card>
        {body}
        <Refusal error={error} testID="compliance-pause-refusal" />
      </Card>
      <ConfirmSheet
        testID="compliance-pause-confirm"
        visible={asking}
        title={t('compliance.pause.confirmTitle')}
        confirmLabel={t('compliance.pause.action')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          pause.mutate();
        }}
        disabled={!writable}
      >
        {t(pauseStore ? 'compliance.pause.confirmStore' : 'compliance.pause.confirmBody')}
      </ConfirmSheet>
    </Section>
  );
}

/** Only a slowdown a reach drop started can be overridden, only by the owner, and only with the word typed (PRD 4.3). */
function SlowModePanel({ status, writable }) {
  const { api } = useServices();
  const { user } = useSession();
  const { t, locale } = useStrings();
  const [typed, setTyped] = useState('');
  const override = useStatusChange(() => api.compliance.slowModeOverride({ confirmation: typed.trim() }));
  if (!status.slowMode.active) return null;
  const canOverride = status.slowMode.canOverride && user?.role === 'owner';
  return (
    <Section title={t('compliance.slow.title')}>
      <Card testID="compliance-slow">
        <Text variant="small">
          {status.slowMode.until ? t('compliance.slow.until', { when: formatDateTime(status.slowMode.until, { locale }) }) : t('compliance.slow.body')}
        </Text>
        {canOverride ? (
          <>
            <Banner tone="warn">{t('compliance.slow.warning')}</Banner>
            <Field testID="compliance-slow-typed" label={t('compliance.slow.typeLabel')} value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} />
            <Button testID="compliance-slow-override" kind="secondary" label={t('compliance.slow.action')} busy={override.isPending} disabled={!writable || !overrideTyped(typed)} onPress={() => override.mutate()} />
            <Refusal error={override.error} testID="compliance-slow-refusal" />
          </>
        ) : null}
      </Card>
    </Section>
  );
}

function HeldPanel({ canDiscard, writable }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const held = usePaged(['compliance', 'held'], (query) => api.compliance.heldJobs(query), { limit: 20 });
  const discard = useMutation({
    mutationFn: () => api.compliance.discardHeld({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance'] }),
  });
  return (
    <Section
      title={t('compliance.held.title')}
      action={canDiscard && held.items.length > 0 ? <Button testID="compliance-discard" kind="quiet" label={t('compliance.held.discard')} disabled={!writable} busy={discard.isPending} onPress={() => setAsking(true)} /> : null}
    >
      <Card>
        <PagedState query={held} testID="compliance-held" emptyTitle={t('compliance.held.empty')} emptyBody={t('compliance.held.emptyBody')}>
          {held.items.map((job, i) => (
            <View key={job.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`held-${job.id}`}
                title={describeKind(t, job.kind)}
                subtitle={`${describeReason(t, job.reason) || t('compliance.held.waiting')} ${t('compliance.held.expires', { when: formatDateTime(job.expiresAt, { locale }) })}`}
              />
            </View>
          ))}
        </PagedState>
        {discard.isSuccess ? <Banner tone="good" testID="compliance-discarded">{t('compliance.held.discarded', { count: discard.data?.discarded ?? 0 })}</Banner> : null}
        <Refusal error={discard.error} testID="compliance-discard-refusal" />
      </Card>
      <ConfirmSheet
        testID="compliance-discard-confirm"
        visible={asking}
        title={t('compliance.held.confirmTitle')}
        confirmLabel={t('compliance.held.discard')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          discard.mutate();
        }}
        disabled={!writable}
      >
        {t('compliance.held.confirmBody')}
      </ConfirmSheet>
    </Section>
  );
}

function GatesPanel({ gates }) {
  const { t } = useStrings();
  const byCode = new Map((gates ?? []).map((gate) => [gate.code, gate]));
  const shown = [...GATES.filter((code) => byCode.has(code)), ...[...byCode.keys()].filter((code) => !GATES.includes(code))];
  if (!shown.length) return null;
  return (
    <Section title={t('compliance.gates.title')}>
      <Card>
        {shown.map((code, i) => (
          <View key={code}>
            {i > 0 ? <Divider /> : null}
            <ListRow
              testID={`gate-${code}`}
              title={GATES.includes(code) ? t(`compliance.gate.${code}`) : code}
              end={<Badge label={t(byCode.get(code).passed ? 'compliance.gates.passed' : 'compliance.gates.notYet')} tone={byCode.get(code).passed ? 'good' : 'warn'} />}
            />
          </View>
        ))}
      </Card>
    </Section>
  );
}

/**
 * Sending rules (PRD 4): what is keeping the account safe right now, the switch that stops every message, slow mode,
 * what is waiting to send and Meta's checks. Staff with the automations permission read it; the owner and managers
 * change it, and the server refuses anyone else again.
 */
export default function ComplianceScreen({ navigation }) {
  const { t } = useStrings();
  const { user } = useSession();
  const writable = useWritable();
  const { status, connection, facebook } = useStatusSources();
  const canManage = isAllowed(user, MANAGERS);
  return (
    <Screen testID="screen-compliance" title={t('compliance.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('compliance.intro')}</Text>
      <RecordState query={status} testID="compliance-status">
        {(current) => (
          <>
            <StatusHero status={current} />
            <NoticeList notices={statusNotices({ status: current, connection: connection.data, facebook: facebook.data }).filter((notice) => notice.key !== 'paused')} />
            <PausePanel status={current} canManage={canManage} writable={writable} />
            <SlowModePanel status={current} writable={writable} />
            <HeldPanel canDiscard={canManage} writable={writable} />
            <GatesPanel gates={current.gates} />
          </>
        )}
      </RecordState>
      <Card>
        <ListRow testID="compliance-open-log" title={t('compliance.log.title')} subtitle={t('compliance.log.blurb')} onPress={() => navigation?.navigate('compliance.log')} />
        <Divider />
        <ListRow testID="compliance-open-rules" title={t('compliance.rules.title')} subtitle={t('compliance.rules.blurb')} onPress={() => navigation?.navigate('compliance.rules')} />
      </Card>
    </Screen>
  );
}
