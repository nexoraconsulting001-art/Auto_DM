import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, Field, ListRow, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { loyaltySettingsBody, loyaltySettingsForm, pointsAdjustBody, signed } from '../orders/kit/forms.js';
import { ActionMessages, NumberField, Offline, PagedList, RecordView, RupeeField, StatusBadge, formatWhenAt, useAction, useAllowed, useForm, useProblem, usePaged, useWritable } from '../orders/kit/ui.js';

const LOYALTY = ['loyalty'];

/** Loyalty (PRD 9.21): members and their points, and referrals with what each one earned or why it was blocked. */
export default function LoyaltyScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const allowed = useAllowed();
  const [tab, setTab] = useState('members');
  const members = usePaged(['loyalty', 'members'], (page) => api.loyalty.members(page), { enabled: tab === 'members' });
  const referrals = usePaged(['loyalty', 'referrals'], (page) => api.loyalty.referrals(page), { enabled: tab === 'referrals' });
  return (
    <Screen testID="screen-loyalty" title={t('loyalty.title')}>
      <Offline />
      {allowed(MANAGERS) ? <Button testID="loyalty-settings" kind="secondary" label={t('loyalty.settings')} onPress={() => navigation.navigate('loyalty.settings')} /> : null}
      <Choices testID="loyalty-tab" label={t('loyalty.title')} value={tab} onChange={setTab} options={[{ value: 'members', label: t('loyalty.members') }, { value: 'referrals', label: t('loyalty.referrals') }]} />
      {tab === 'members' ? (
        <PagedList
          testID="loyalty-members"
          query={members}
          rowKey={(m) => m.shopperId}
          emptyTitle={t('loyalty.membersEmpty')}
          renderRow={(member) => (
            <ListRow
              testID={`member-${member.shopperId}`}
              title={member.name || t('loyalty.noName')}
              subtitle={[t('loyalty.balance', { points: member.balance }), member.pending ? t('loyalty.pending', { points: member.pending }) : null].filter(Boolean).join(' · ')}
              onPress={() => navigation.navigate('loyalty.member', { id: member.shopperId })}
            />
          )}
        />
      ) : (
        <PagedList
          testID="loyalty-referrals"
          query={referrals}
          emptyTitle={t('loyalty.referralsEmpty')}
          renderRow={(ref) => (
            <ListRow
              testID={`referral-${ref.id}`}
              title={t('loyalty.referralBy', { id: ref.referrerShopperId })}
              subtitle={[ref.blockReason ? t('loyalty.blocked', { reason: ref.blockReason }) : null, formatWhenAt(ref.createdAt, locale)].filter(Boolean).join(' · ')}
              end={<StatusBadge group="referral" status={ref.status} />}
            />
          )}
        />
      )}
    </Screen>
  );
}

/** One member: every earn, spend, expiry and adjustment. The owner can add or take away points, with a note. */
export function MemberScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const allowed = useAllowed();
  const writable = useWritable();
  const ledger = usePaged(['loyalty', 'ledger', id], (page) => api.loyalty.ledger(id, page), { enabled: id > 0 });
  const action = useAction([LOYALTY]);
  const form = useForm({ points: '', note: '' });
  const problem = useProblem(form.problems);
  const [member, setMember] = useState(null);

  async function adjust() {
    const built = pointsAdjustBody(form.values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    const answer = await action.run('adjust', () => api.loyalty.adjust(id, built.body), { done: 'loyalty.adjusted' });
    if (answer) {
      setMember(answer);
      form.reset({ points: '', note: '' });
    }
  }

  return (
    <Screen testID="screen-loyalty-member" title={member?.name || t('loyalty.member')}>
      <Offline />
      {member ? <Text variant="title" testID="member-balance">{t('loyalty.balance', { points: member.balance })}</Text> : null}
      <PagedList
        testID="member-ledger"
        query={ledger}
        emptyTitle={t('loyalty.ledgerEmpty')}
        renderRow={(entry) => (
          <ListRow
            testID={`entry-${entry.id}`}
            title={t(`loyalty.kind.${entry.kind}`)}
            subtitle={[formatWhenAt(entry.at, locale), entry.status !== 'posted' ? t(`loyalty.entry.${entry.status}`) : null, entry.expiresAt ? t('loyalty.expires', { when: formatWhenAt(entry.expiresAt, locale) }) : null].filter(Boolean).join(' · ')}
            end={<Badge tone={entry.points > 0 ? 'good' : 'neutral'} label={signed(entry.points)} />}
            onPress={entry.orderId ? () => openLink(`/orders/${entry.orderId}`) : undefined}
          />
        )}
      />
      {allowed(OWNER_ONLY) ? (
        <Section title={t('loyalty.adjust')} testID="member-adjust">
          <Card>
            <NumberField testID="member-adjust-points" signed label={t('loyalty.adjustPoints')} value={form.values.points} onChangeText={form.set('points')} error={problem('points')} />
            <Field testID="member-adjust-note" label={t('loyalty.adjustNote')} value={form.values.note} onChangeText={form.set('note')} error={problem('note')} maxLength={200} />
            <ActionMessages action={action} testID="member-adjust-action" />
            <Button testID="member-adjust-save" label={t('loyalty.adjustSave')} disabled={!writable} busy={action.busy === 'adjust'} onPress={() => { adjust(); }} />
          </Card>
        </Section>
      ) : <View style={{ height: theme.space[2] }} />}
    </Screen>
  );
}

/** How points are earned and spent, and referrals. */
export function LoyaltySettingsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const settings = useQuery({ queryKey: ['loyalty', 'settings'], queryFn: () => api.loyaltySettings.get() });
  return (
    <Screen testID="screen-loyalty-settings" title={t('loyalty.settings')}>
      <Offline />
      <RecordView query={settings} testID="loyalty-settings">
        {(data) => <SettingsForm key={JSON.stringify(data)} settings={data} />}
      </RecordView>
    </Screen>
  );
}

function SettingsForm({ settings }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const form = useForm(loyaltySettingsForm(settings));
  const problem = useProblem(form.problems);
  const action = useAction([['loyalty', 'settings']]);
  const { values, set } = form;

  async function save() {
    const built = loyaltySettingsBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('save', () => api.loyaltySettings.update(built.body), { done: 'loyalty.saved' });
  }

  return (
    <Card testID="loyalty-settings-form">
      {!settings.available ? <Banner tone="warn" testID="loyalty-unavailable">{t('loyalty.unavailable')}</Banner> : null}
      <Toggle testID="loyalty-enabled" title={t('loyalty.enabled')} value={values.enabled} onValueChange={set('enabled')} disabled={!settings.available} />
      <NumberField testID="loyalty-earn-points" label={t('loyalty.earnPoints')} value={values.earnPoints} onChangeText={set('earnPoints')} error={problem('earnPoints')} />
      <RupeeField testID="loyalty-earn-per" label={t('loyalty.earnPer')} value={values.earnPer} onChangeText={set('earnPer')} error={problem('earnPer')} />
      <RupeeField testID="loyalty-point-value" label={t('loyalty.pointValue')} value={values.pointValue} onChangeText={set('pointValue')} error={problem('pointValue')} />
      <NumberField testID="loyalty-max-redeem" label={t('loyalty.maxRedeem')} value={values.maxRedeemPoints} onChangeText={set('maxRedeemPoints')} error={problem('maxRedeemPoints')} />
      <NumberField testID="loyalty-expiry" label={t('loyalty.expiry')} hint={t('loyalty.expiryHint')} value={values.expiryDays} onChangeText={set('expiryDays')} error={problem('expiryDays')} />
      <Text variant="title">{t('loyalty.referrals')}</Text>
      <Toggle testID="loyalty-referral" title={t('loyalty.referralEnabled')} value={values.referralEnabled} onValueChange={set('referralEnabled')} disabled={!settings.available} />
      {values.referralEnabled ? (
        <>
          <RupeeField testID="loyalty-friend-reward" label={t('loyalty.friendReward')} value={values.friendReward} onChangeText={set('friendReward')} error={problem('friendReward')} />
          <NumberField testID="loyalty-referrer-points" label={t('loyalty.referrerPoints')} value={values.referrerPoints} onChangeText={set('referrerPoints')} error={problem('referrerPoints')} />
        </>
      ) : null}
      <ActionMessages action={action} testID="loyalty-settings-action" />
      <Button testID="loyalty-settings-save" label={t('common.save')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
    </Card>
  );
}
