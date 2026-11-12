/**
 * Test mode and the numbers (PRD 6.5, 6.9): testers who may get real DMs while an automation is in Test, a test send
 * that goes through every check and says what happened and why, and each variant's sends with the winner picked.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, EmptyState, Field, ListRow, Section, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { PagedState, RecordState, Refusal, formatDateTime, usePaged } from '../compliance/kit.js';
import { describeOutcome, describeReason } from '../compliance/reasons.js';

export const TESTERS_KEY = ['automations', 'testers'];
const testerName = (t, tester) => tester.label || t('automations.testers.unnamed', { id: tester.id });

function AddTester({ writable }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const create = useMutation({
    mutationFn: () => api.testers.createCode({ label: label.trim() }),
    onSuccess: () => {
      setLabel('');
      return queryClient.invalidateQueries({ queryKey: TESTERS_KEY });
    },
  });
  return (
    <View style={{ gap: theme.space[2] }}>
      <Field testID="testers-label" label={t('automations.testers.who')} value={label} onChangeText={setLabel} maxLength={60} autoCorrect={false} editable={writable} />
      <Button testID="testers-add" kind="secondary" label={t('automations.testers.add')} busy={create.isPending} disabled={!writable} onPress={() => create.mutate()} />
      {create.data ? (
        <Banner testID="testers-code" tone="good" title={create.data.code}>{t('automations.testers.codeBody', { when: formatDateTime(create.data.expiresAt, { locale }) })}</Banner>
      ) : null}
      <Refusal error={create.error} testID="testers-add-refusal" />
    </View>
  );
}

/** "Send test to me": only to a tester who messaged in the last 24 hours. The answer is the engine's, with its reason. */
function SendTest({ automation, testers, writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const ready = testers.filter((tester) => tester.windowOpen);
  const [testerId, setTesterId] = useState('');
  const [variantLabel, setVariantLabel] = useState('');
  const chosen = testerId || String(ready[0]?.id ?? '');
  const send = useMutation({ mutationFn: () => api.automations.sendTest(automation.id, { testerId: Number(chosen), ...(variantLabel ? { variantLabel } : {}) }) });
  if (!ready.length) return <Text variant="meta" testID="send-test-waiting">{t('automations.testers.needWindow')}</Text>;
  const outcome = send.data ? describeOutcome(t, send.data.outcome) : null;
  return (
    <View style={{ gap: theme.space[2] }}>
      <Choices testID="send-test-to" label={t('automations.testers.sendTo')} value={chosen} onChange={setTesterId} options={ready.map((tester) => ({ value: String(tester.id), label: testerName(t, tester) }))} />
      {automation.variants.length > 1 ? (
        <Choices testID="send-test-variant" label={t('automations.testers.variant')} value={variantLabel} onChange={setVariantLabel} options={[{ value: '', label: t('automations.testers.anyVariant') }, ...automation.variants.map((v) => ({ value: v.label, label: v.label }))]} />
      ) : null}
      <Button testID="send-test" kind="secondary" label={t('automations.testers.send')} busy={send.isPending} disabled={!writable} onPress={() => send.mutate()} />
      {outcome ? (
        <Banner testID="send-test-result" tone={outcome.tone === 'good' ? 'good' : 'warn'} title={outcome.label}>
          {[describeReason(t, send.data.reason), send.data.reason].filter(Boolean).join('\n')}
        </Banner>
      ) : null}
      <Refusal error={send.error} testID="send-test-refusal" />
    </View>
  );
}

export function TestersPanel({ automation, writable }) {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const canManage = isAllowed(user, MANAGERS);
  const [removing, setRemoving] = useState(null);
  const testers = usePaged(TESTERS_KEY, (query) => api.testers.list(query), { limit: 50 });
  const remove = useMutation({
    mutationFn: (id) => api.testers.remove(id),
    onSuccess: () => {
      setRemoving(null);
      return queryClient.invalidateQueries({ queryKey: TESTERS_KEY });
    },
  });
  return (
    <Section title={t('automations.testers.title')}>
      <Card testID="testers">
        <Text variant="small">{t('automations.testers.intro')}</Text>
        <PagedState query={testers} testID="testers-list" emptyTitle={t('automations.testers.empty')} emptyBody={t('automations.testers.emptyBody')}>
          {testers.items.map((tester, i) => (
            <View key={tester.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`tester-${tester.id}`}
                title={testerName(t, tester)}
                subtitle={t(tester.windowOpen ? 'automations.testers.ready' : 'automations.testers.waiting')}
                end={canManage ? <Button testID={`tester-${tester.id}-remove`} kind="quiet" label={t('automations.testers.remove')} disabled={!writable} onPress={() => setRemoving(tester)} /> : null}
              />
            </View>
          ))}
        </PagedState>
        <SendTest automation={automation} testers={testers.items} writable={writable} />
        <Refusal error={remove.error} testID="testers-remove-refusal" />
        {canManage ? <AddTester writable={writable} /> : null}
      </Card>
      <ConfirmSheet
        testID="testers-remove-confirm"
        visible={Boolean(removing)}
        title={t('automations.testers.removeTitle')}
        confirmLabel={t('automations.testers.remove')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => remove.mutate(removing.id)}
        busy={remove.isPending}
        disabled={!writable}
      >
        {t('automations.testers.removeBody')}
      </ConfirmSheet>
    </Section>
  );
}

const ratePercent = (rate) => (rate === null || rate === undefined ? '' : `${(rate * 100).toFixed(1)}%`);

export function StatsPanel({ automation, writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const stats = useQuery({ queryKey: ['automations', 'stats', String(automation.id)], queryFn: () => api.automations.stats(automation.id) });
  const pick = useMutation({
    mutationFn: (variantId) => api.automations.pickWinner(automation.id, { variantId }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['automations', 'detail', String(automation.id)], saved);
      return queryClient.invalidateQueries({ queryKey: ['automations'] });
    },
  });
  return (
    <Section title={t('automations.stats.title')}>
      <Card testID="stats">
        <RecordState query={stats} testID="stats-numbers">
          {(numbers) => (numbers.sends === 0 ? <EmptyState testID="stats-empty" title={t('automations.stats.empty')}>{t('automations.stats.emptyBody')}</EmptyState> : numbers.variants.map((variant, i) => {
            const winner = automation.winnerVariantId === variant.variantId;
            const line = [
              t('automations.stats.sent', { count: variant.sends }),
              variant.taps === null ? '' : t('automations.stats.taps', { count: variant.taps }),
              ratePercent(variant.rate),
            ].filter(Boolean).join(', ');
            return (
              <View key={variant.variantId} testID={`stats-${variant.label}`} style={{ gap: theme.space[1] }}>
                {i > 0 ? <Divider /> : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
                  <Text variant="title" style={{ flex: 1 }}>{t('automations.message.variant', { label: variant.label })}</Text>
                  {winner ? <Badge testID={`stats-${variant.label}-winner`} label={t('automations.stats.winner')} tone="good" /> : null}
                  {!winner && variant.leader ? <Badge testID={`stats-${variant.label}-leader`} label={t('automations.stats.leading')} tone="primary" /> : null}
                </View>
                <Text variant="meta">{line}</Text>
                {!winner && numbers.variants.length > 1 ? <Button testID={`stats-${variant.label}-pick`} kind="quiet" label={t('automations.stats.pick', { label: variant.label })} disabled={!writable} busy={pick.isPending && pick.variables === variant.variantId} onPress={() => pick.mutate(variant.variantId)} /> : null}
              </View>
            );
          }))}
        </RecordState>
        {pick.isSuccess ? <Banner testID="stats-picked" tone="good">{t('automations.stats.picked')}</Banner> : null}
        <Refusal error={pick.error} testID="stats-refusal" />
      </Card>
    </Section>
  );
}
