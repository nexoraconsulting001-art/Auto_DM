import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY } from '@bhava/app-core/access';
import { Button, Card, Choices, ConfirmSheet, Field, ListRow, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { RETURN_PROOF, returnSettingsBody } from '../orders/kit/forms.js';
import { returnMoves } from '../orders/kit/rules.js';
import { ActionMessages, ManyChoices, NumberField, Offline, PagedList, RecordView, StatusBadge, formatWhenAt, openOutside, useAction, useAllowed, useForm, useProblem, usePaged, useWritable } from '../orders/kit/ui.js';

const RETURNS = ['returns'];
const SHOW = ['', 'requested', 'approved', 'received', 'refunded', 'rejected'];

/** Returns (PRD 9.17): what shoppers asked to send back, newest first, by where each one is. */
export default function ReturnsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const allowed = useAllowed();
  const [status, setStatus] = useState('requested');
  const query = usePaged(['returns', 'list', status], (page) => api.returns.list({ ...(status ? { status } : {}), ...page }));
  return (
    <Screen testID="screen-returns" title={t('returns.title')}>
      <Offline />
      {allowed(MANAGERS) ? <Button testID="returns-settings" kind="secondary" label={t('returns.settings')} onPress={() => navigation.navigate('returns.settings')} /> : null}
      <Choices testID="returns-show" label={t('orders.filterLabel')} value={status} onChange={setStatus} options={SHOW.map((value) => ({ value, label: value ? t(`orders.status.return.${value}`) : t('orders.filter.all') }))} />
      <PagedList
        testID="returns-list"
        query={query}
        emptyTitle={t('returns.empty')}
        renderRow={(ret) => (
          <ListRow
            testID={`return-${ret.id}`}
            title={`${ret.orderNumber} · ${t(`returns.resolution.${ret.resolution}`)}`}
            subtitle={[ret.reason, formatWhenAt(ret.createdAt, locale)].filter(Boolean).join(' · ')}
            end={<StatusBadge group="return" status={ret.status} />}
            onPress={() => navigation.navigate('returns.detail', { id: ret.id })}
          />
        )}
      />
    </Screen>
  );
}

/** The shopper's photos and videos. A photo shows here; a video opens in the system's player. Links are short-lived. */
function Proofs({ proofs }) {
  const { t } = useStrings();
  const theme = useTheme();
  if (!proofs.length) return <Text variant="small">{t('returns.noProof')}</Text>;
  return (
    <View testID="return-proofs" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
      {proofs.map((proof, i) => (proof.kind === 'photo' ? (
        <Pressable key={proof.id} testID={`return-proof-${proof.id}`} accessibilityRole="imagebutton" accessibilityLabel={t('returns.photo', { n: i + 1 })} onPress={() => { openOutside(proof.fileUrl); }}>
          <Image source={{ uri: proof.fileUrl }} style={{ width: 96, height: 96, borderRadius: theme.radius.tile, backgroundColor: theme.color.surfaceSunken }} contentFit="cover" cachePolicy="none" />
        </Pressable>
      ) : (
        <Button key={proof.id} testID={`return-proof-${proof.id}`} kind="secondary" label={t('returns.video', { n: i + 1 })} onPress={() => { openOutside(proof.fileUrl); }} />
      )))}
    </View>
  );
}

/** One return: the items, the reason, the proof, and the next step the server allows. */
export function ReturnScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  // Proof links are short-lived and private: this record is never written to the phone.
  const ret = useQuery({ queryKey: ['returns', 'detail', id], queryFn: () => api.returns.get(id), enabled: id > 0, meta: { offline: false } });
  return (
    <Screen testID="screen-return">
      <Offline />
      <RecordView query={ret} testID="return">
        {(data) => <Return ret={data} />}
      </RecordView>
    </Screen>
  );
}

function Return({ ret }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const openLink = useOpenLink();
  const allowed = useAllowed();
  const writable = useWritable();
  const action = useAction([RETURNS, ['orders']]);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [condition, setCondition] = useState('good');
  const [exchanging, setExchanging] = useState(false);
  const moves = returnMoves(ret);
  const run = (key, work, done) => action.run(key, work, { done });

  return (
    <View style={{ gap: theme.space[4] }}>
      <View style={{ gap: theme.space[2] }}>
        <Text variant="page">{ret.orderNumber}</Text>
        <StatusBadge group="return" status={ret.status} testID="return-status" />
        <Text variant="meta">{[t(`returns.resolution.${ret.resolution}`), formatWhenAt(ret.createdAt, locale)].join(' · ')}</Text>
      </View>
      <Card testID="return-items">
        {ret.items.map((item) => <ListRow key={item.orderItemId} title={item.name} subtitle={t('returns.qty', { qty: item.qty })} />)}
        {ret.reason ? <Text variant="small">{ret.reason}</Text> : null}
        {ret.condition ? <Text variant="meta">{t(`returns.condition.${ret.condition}`)}</Text> : null}
      </Card>
      <Section title={t('returns.proof')}>
        <Proofs proofs={ret.proofs ?? []} />
      </Section>
      <ActionMessages action={action} testID="return-action" />
      {moves.includes('approve') ? <Button testID="return-approve" label={t('returns.approve')} disabled={!writable || Boolean(action.busy)} busy={action.busy === 'approve'} onPress={() => run('approve', () => api.returns.approve(ret.id), 'returns.approved')} /> : null}
      {moves.includes('decline') ? <Button testID="return-decline" kind="danger" label={t('returns.decline')} disabled={!writable || Boolean(action.busy)} onPress={() => setDeclining(true)} /> : null}
      {moves.includes('receive') ? (
        <Card testID="return-receive">
          <Text variant="small">{t('returns.receiveIntro')}</Text>
          <Choices testID="return-condition" label={t('returns.condition')} value={condition} onChange={setCondition} options={['good', 'not_restockable'].map((value) => ({ value, label: t(`returns.condition.${value}`) }))} />
          <Button testID="return-receive-save" label={t('returns.receive')} disabled={!writable || Boolean(action.busy)} busy={action.busy === 'receive'} onPress={() => run('receive', () => api.returns.receive(ret.id, { condition }), 'returns.received')} />
        </Card>
      ) : null}
      {moves.includes('refund') ? (
        allowed(OWNER_ONLY)
          ? <Button testID="return-refund" label={t('returns.refund')} disabled={!writable} onPress={() => navigation.navigate('refunds.create', { id: ret.orderId, returnId: ret.id })} />
          : <Text variant="small" testID="return-refund-owner">{t('returns.refundOwner')}</Text>
      ) : null}
      {moves.includes('exchange') ? <Button testID="return-exchange" kind="secondary" label={t('returns.exchange')} disabled={!writable || Boolean(action.busy)} onPress={() => setExchanging(true)} /> : null}
      {moves.length === 0 ? <Text variant="small" testID="return-closed">{t(['refunded', 'exchanged'].includes(ret.status) ? 'returns.closed' : 'returns.ended')}</Text> : null}
      {ret.shipmentId ? <Button testID="return-parcel" kind="quiet" label={t('returns.parcel')} onPress={() => openLink(`/shipments/${ret.shipmentId}`)} /> : null}
      <Button testID="return-order" kind="quiet" label={t('returns.order')} onPress={() => openLink(`/orders/${ret.orderId}`)} />

      <ConfirmSheet testID="return-decline-confirm" visible={declining} title={t('returns.declineTitle')} confirmLabel={t('returns.decline')} cancelLabel={t('returns.back')} busy={action.busy === 'decline'} disabled={!writable || !note.trim()} onCancel={() => setDeclining(false)}
        onConfirm={async () => {
          const done = await run('decline', () => api.returns.decline(ret.id, { note: note.trim().slice(0, 500) }), 'returns.declined');
          if (done) setNote('');
          setDeclining(false);
        }}
      >
        <Text variant="small">{t('returns.declineBody')}</Text>
        <Field testID="return-decline-note" label={t('returns.declineNote')} value={note} onChangeText={setNote} multiline maxLength={500} />
      </ConfirmSheet>
      <ConfirmSheet testID="return-exchange-confirm" tone="primary" visible={exchanging} title={t('returns.exchangeTitle')} confirmLabel={t('returns.exchange')} cancelLabel={t('returns.back')} busy={action.busy === 'exchange'} disabled={!writable} onCancel={() => setExchanging(false)}
        onConfirm={async () => {
          await run('exchange', () => api.returns.close(ret.id, { resolution: 'exchange' }), 'returns.exchanged');
          setExchanging(false);
        }}
      >
        {t('returns.exchangeBody')}
      </ConfirmSheet>
    </View>
  );
}

/** The return rules: on or off, how many days after delivery, which categories, and the proof shoppers add. */
export function ReturnSettingsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const settings = useQuery({ queryKey: ['returns', 'settings'], queryFn: () => api.returnSettings.get() });
  return (
    <Screen testID="screen-return-settings" title={t('returns.settings')}>
      <Offline />
      <RecordView query={settings} testID="return-settings">
        {(data) => <SettingsForm key={JSON.stringify(data)} settings={data} />}
      </RecordView>
    </Screen>
  );
}

function SettingsForm({ settings }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const categories = useQuery({ queryKey: ['returns', 'categories'], queryFn: () => api.categories.list({ limit: 100 }) });
  const form = useForm({ enabled: settings.enabled, windowDays: String(settings.windowDays), eligibleCategoryIds: settings.eligibleCategoryIds ?? [], proof: settings.proof });
  const problem = useProblem(form.problems);
  const action = useAction([['returns', 'settings']]);
  const { values, set } = form;

  async function save() {
    const built = returnSettingsBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('save', () => api.returnSettings.update(built.body), { done: 'returns.settingsSaved' });
  }

  return (
    <Card testID="return-settings-form">
      <Toggle testID="return-enabled" title={t('returns.enabled')} value={values.enabled} onValueChange={set('enabled')} />
      <NumberField testID="return-window" label={t('returns.window')} hint={t('returns.windowHint')} value={values.windowDays} onChangeText={set('windowDays')} error={problem('windowDays')} />
      <Text variant="title">{t('returns.categories')}</Text>
      <Text variant="small">{t('returns.categoriesHint')}</Text>
      {categories.data ? <ManyChoices testID="return-categories" value={values.eligibleCategoryIds} onChange={set('eligibleCategoryIds')} options={(categories.data.items ?? []).map((c) => ({ value: c.id, label: c.name }))} /> : null}
      <Choices testID="return-proof" label={t('returns.proofKind')} value={values.proof} onChange={set('proof')} options={RETURN_PROOF.map((value) => ({ value, label: t(`returns.proof.${value}`) }))} />
      <ActionMessages action={action} testID="return-settings-action" />
      <Button testID="return-settings-save" label={t('common.save')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
    </Card>
  );
}
