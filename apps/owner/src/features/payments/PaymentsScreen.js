import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Banner, Button, Card, Choices, ConfirmSheet, Field, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { BUSINESS_TYPES, linkedAccountBody, paymentOptionsBody, paymentOptionsForm, razorpayKeysBody, upiBody } from '../orders/kit/forms.js';
import { ActionMessages, CopyLine, Fact, KeyForm, NumberField, Offline, PickerField, RecordView, RupeeField, StatusBadge, openOutside, useAction, useAllowed, useForm, useProblem, useWritable } from '../orders/kit/ui.js';

export const ACCOUNT = ['payments', 'account'];
export const OPTIONS = ['payments', 'options'];
const SETTINGS = ['settings', 'store'];

/**
 * Payments (PRD 9.5 to 9.7, 10.4): how the business is paid, in either mode, and the ways shoppers pay.
 *
 *   managed  the platform's gateway account with a linked account for this business, after KYC
 *   own      the business's own Razorpay account: connected by signing in (in the system browser) or with its keys
 *
 * Keys are typed into write-only fields after a fresh check (P-17) and never come back. Only the owner changes how the
 * business is paid; a manager sees it and edits the ways to pay. Staff never see this screen (P-12).
 */
export default function PaymentsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const allowed = useAllowed();
  const account = useQuery({ queryKey: ACCOUNT, queryFn: () => api.paymentAccount.get() });
  const options = useQuery({ queryKey: OPTIONS, queryFn: () => api.paymentSettings.get() });
  return (
    <Screen testID="screen-payments" title={t('payments.title')}>
      <Offline />
      <RecordView query={account} testID="payments-account">
        {(data) => <AccountPanel account={data} />}
      </RecordView>
      <Section title={t('payments.methods')} testID="payments-methods">
        <RecordView query={options} testID="payments-options">
          {(data) => <MethodsForm key={JSON.stringify(data)} options={data} />}
        </RecordView>
      </Section>
      {allowed(OWNER_ONLY) ? <UpiForm /> : null}
      <Button testID="payments-statement" kind="secondary" label={t('payments.statement.title')} onPress={() => navigation.navigate('payments.statement')} />
    </Screen>
  );
}

function AccountPanel({ account }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const allowed = useAllowed();
  const writable = useWritable();
  const owner = allowed(OWNER_ONLY);
  const action = useAction([ACCOUNT, OPTIONS]);
  const [switching, setSwitching] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [keys, setKeys] = useState(false);
  const other = account.mode === 'managed' ? 'own' : 'managed';

  async function connect() {
    const answer = await action.run('connect', () => api.paymentAccount.connectUrl(), { fresh: true });
    if (answer?.url) {
      await openOutside(answer.url);
      action.clear();
    }
  }

  return (
    <Card testID="payments-mode">
      <View style={{ gap: theme.space[1] }}>
        <Text variant="title">{t(`payments.mode.${account.mode}`)}</Text>
        <Text variant="small">{t(`payments.mode.${account.mode}.note`)}</Text>
      </View>
      <ActionMessages action={action} testID="payments-account-action" />
      {account.mode === 'managed' ? (
        <View style={{ gap: theme.space[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
            <Text variant="small" style={{ flex: 1 }}>{t('payments.kyc')}</Text>
            <StatusBadge group="kyc" status={account.kycStatus} testID="payments-kyc" />
          </View>
          {account.linkedAccount ? <Fact label={t('payments.linked')} value={account.linkedAccount} /> : null}
          {account.kycStatus === 'pending' ? <Banner tone="warn" testID="payments-kyc-pending">{t('payments.kyc.pending')}</Banner> : null}
          {['not_started', 'rejected'].includes(account.kycStatus) ? (owner ? <LinkedAccountForm rejected={account.kycStatus === 'rejected'} /> : <Text variant="small">{t('payments.kyc.ownerStarts')}</Text>) : null}
        </View>
      ) : (
        <View style={{ gap: theme.space[3] }}>
          <Fact label={t('payments.own.connected')} value={t(`payments.own.connection.${account.ownConnection}`)} />
          {account.ownAccount ? <Fact label={t('payments.own.account')} value={account.ownAccount} /> : null}
          <CopyLine testID="payments-webhook" label={t('payments.own.webhook')} value={account.webhookUrl} />
          {owner ? (
            <>
              <Button testID="payments-connect" label={t(account.ownConnection === 'none' ? 'payments.own.connect' : 'payments.own.reconnect')} disabled={!writable} busy={action.busy === 'connect'} onPress={() => { connect(); }} />
              {account.ownConnection !== 'none' ? <Button testID="payments-disconnect" kind="danger" label={t('payments.own.disconnect')} disabled={!writable} onPress={() => setDisconnecting(true)} /> : null}
              <Button testID="payments-use-keys" kind="quiet" label={t(keys ? 'payments.keys.hide' : 'payments.keys.show')} onPress={() => setKeys((on) => !on)} />
              {keys ? (
                <KeyForm
                  testID="payments-keys"
                  intro={t('payments.keys.intro')}
                  fields={[
                    { name: 'razorpayKeyId', label: t('payments.keys.id'), hint: t('payments.keys.idHint') },
                    { name: 'razorpayKeySecret', label: t('payments.keys.secret'), secret: true, saved: account.ownConnection === 'keys' },
                  ]}
                  build={razorpayKeysBody}
                  save={(body) => api.settings.updatePayment(body)}
                  submitLabel={t('payments.keys.save')}
                  doneKey="payments.keys.saved"
                  reload={[ACCOUNT, OPTIONS]}
                />
              ) : null}
            </>
          ) : null}
        </View>
      )}
      {owner ? (
        <Button testID="payments-switch" kind="secondary" label={t('payments.switch', { mode: t(`payments.mode.${other}`) })} disabled={!writable} onPress={() => setSwitching(true)} />
      ) : (
        <Text variant="meta" testID="payments-owner-only">{t('payments.ownerOnly')}</Text>
      )}
      <ConfirmSheet
        testID="payments-switch-confirm"
        visible={switching}
        tone="primary"
        title={t('payments.switchTitle', { mode: t(`payments.mode.${other}`) })}
        confirmLabel={t('payments.switchYes')}
        cancelLabel={t('payments.keep')}
        busy={action.busy === 'mode'}
        disabled={!writable}
        onCancel={() => setSwitching(false)}
        onConfirm={async () => {
          await action.run('mode', () => api.paymentAccount.setMode({ mode: other }), { fresh: true, done: 'payments.switched' });
          setSwitching(false);
        }}
      >
        {t('payments.switchBody')}
      </ConfirmSheet>
      <ConfirmSheet
        testID="payments-disconnect-confirm"
        visible={disconnecting}
        title={t('payments.own.disconnectTitle')}
        confirmLabel={t('payments.own.disconnect')}
        cancelLabel={t('payments.keep')}
        busy={action.busy === 'disconnect'}
        disabled={!writable}
        onCancel={() => setDisconnecting(false)}
        onConfirm={async () => {
          await action.run('disconnect', () => api.paymentAccount.disconnect(), { fresh: true, done: 'payments.own.disconnected' });
          setDisconnecting(false);
        }}
      >
        {t('payments.own.disconnectBody')}
      </ConfirmSheet>
    </Card>
  );
}

/** The managed account's KYC: the owner gives the business's details once (fresh, as it sets where money goes). */
function LinkedAccountForm({ rejected }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const form = useForm({ legalName: '', contactName: '', email: '', phone: '', businessType: 'proprietorship' });
  const problem = useProblem(form.problems);
  const action = useAction([ACCOUNT, OPTIONS]);
  const { values, set } = form;

  async function submit() {
    const built = linkedAccountBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('kyc', () => api.paymentAccount.startLinked(built.body), { fresh: true, done: 'payments.kyc.sent' });
  }

  return (
    <View testID="payments-kyc-form" style={{ gap: 12 }}>
      <Text variant="small">{t(rejected ? 'payments.kyc.rejected' : 'payments.kyc.start')}</Text>
      <Field testID="payments-kyc-legal" label={t('payments.kyc.legalName')} value={values.legalName} onChangeText={set('legalName')} error={problem('legalName')} maxLength={200} autoComplete="organization" />
      <PickerField testID="payments-kyc-type" label={t('payments.kyc.type')} value={values.businessType} onChange={set('businessType')} options={BUSINESS_TYPES.map((value) => ({ value, label: t(`payments.business.${value}`) }))} />
      <Field testID="payments-kyc-contact" label={t('payments.kyc.contactName')} value={values.contactName} onChangeText={set('contactName')} error={problem('contactName')} maxLength={80} autoComplete="name" />
      <Field testID="payments-kyc-email" label={t('payments.kyc.email')} value={values.email} onChangeText={set('email')} error={problem('email')} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
      <Field testID="payments-kyc-phone" label={t('payments.kyc.phone')} value={values.phone} onChangeText={set('phone')} error={problem('phone')} keyboardType="phone-pad" maxLength={16} autoComplete="tel" />
      <ActionMessages action={action} testID="payments-kyc-action" />
      <Button testID="payments-kyc-submit" label={t('payments.kyc.submit')} disabled={!writable} busy={action.busy === 'kyc'} onPress={() => { submit(); }} />
    </View>
  );
}

/** The ways shoppers pay: online methods, cash on delivery and its limits, part advance, and how long stock is held. */
function MethodsForm({ options }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const form = useForm(paymentOptionsForm(options));
  const problem = useProblem(form.problems);
  const action = useAction([OPTIONS]);
  const { values, set } = form;
  const percent = values.advanceKind === 'percent';

  async function save() {
    const built = paymentOptionsBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('save', () => api.paymentSettings.update(built.body), { done: 'payments.saved' });
  }

  return (
    <Card testID="payments-methods-form">
      {!options.onlineReady ? <Banner tone="warn" testID="payments-not-ready">{t('payments.notReady')}</Banner> : null}
      <Text variant="title">{t('payments.online')}</Text>
      {['upi', 'card', 'netbanking', 'wallet'].map((name) => <Toggle key={name} testID={`payments-method-${name}`} title={t(`payments.method.${name}`)} value={values[name]} onValueChange={set(name)} disabled={!writable} />)}
      <Text variant="title">{t('payments.cod')}</Text>
      <Toggle testID="payments-cod" title={t('payments.cod.offer')} value={values.cod} onValueChange={set('cod')} disabled={!writable} />
      {values.cod ? (
        <>
          <RupeeField testID="payments-cod-fee" label={t('payments.cod.fee')} hint={t('payments.cod.feeHint')} value={values.codFee} onChangeText={set('codFee')} error={problem('codFee')} />
          <RupeeField testID="payments-cod-max" label={t('payments.cod.max')} hint={t('payments.cod.maxHint')} value={values.codMax} onChangeText={set('codMax')} error={problem('codMax')} />
          <Field testID="payments-cod-pins" label={t('payments.cod.pins')} hint={t('payments.cod.pinsHint')} value={values.codPins} onChangeText={set('codPins')} error={problem('codPins')} keyboardType="numbers-and-punctuation" multiline maxLength={4000} />
          <NumberField testID="payments-cod-block" label={t('payments.cod.block')} hint={t('payments.cod.blockHint')} value={values.codBlock} onChangeText={set('codBlock')} error={problem('codBlock')} />
        </>
      ) : null}
      <Text variant="title">{t('payments.advance')}</Text>
      <Toggle testID="payments-advance" title={t('payments.advance.ask')} value={values.partAdvance} onValueChange={set('partAdvance')} disabled={!writable} />
      {values.partAdvance ? (
        <>
          <Choices testID="payments-advance-kind" label={t('payments.advance.kind')} value={values.advanceKind} onChange={set('advanceKind')} options={[{ value: 'fixed', label: t('payments.advance.fixed') }, { value: 'percent', label: t('payments.advance.percent') }]} />
          {percent ? (
            <Field testID="payments-advance-value" label={t('payments.advance.percentLabel')} value={values.advanceValue} onChangeText={set('advanceValue')} error={problem('advanceValue')} keyboardType="decimal-pad" maxLength={6} />
          ) : (
            <RupeeField testID="payments-advance-value" label={t('payments.advance.amount')} value={values.advanceValue} onChangeText={set('advanceValue')} error={problem('advanceValue')} />
          )}
        </>
      ) : null}
      <NumberField testID="payments-hold" label={t('payments.hold')} hint={t('payments.holdHint')} value={values.holdMinutes} onChangeText={set('holdMinutes')} error={problem('holdMinutes')} />
      <ActionMessages action={action} testID="payments-methods-action" />
      <Button testID="payments-save" label={t('payments.save')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
    </Card>
  );
}

/** Orders taken by hand show a payment QR: the UPI id on it and the payee's name. Owner only, after a fresh check. */
function UpiForm() {
  const { api } = useServices();
  const settings = useQuery({ queryKey: SETTINGS, queryFn: () => api.settings.get() });
  if (!settings.data) return null;
  return <UpiFields key={`${settings.data.upiId}|${settings.data.upiPayee}`} settings={settings.data} />;
}

function UpiFields({ settings }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const form = useForm({ upiId: settings.upiId ?? '', upiPayee: settings.upiPayee ?? '' });
  const problem = useProblem(form.problems);
  const action = useAction([SETTINGS]);

  async function save() {
    const built = upiBody(form.values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('upi', () => api.settings.updatePayment(built.body), { fresh: true, done: 'payments.upi.saved' });
  }

  return (
    <Section title={t('payments.upi.title')} testID="payments-upi">
      <Card>
        <Text variant="small">{t('payments.upi.intro')}</Text>
        <Field testID="payments-upi-id" label={t('payments.upi.id')} value={form.values.upiId} onChangeText={form.set('upiId')} error={problem('upiId')} autoCapitalize="none" autoCorrect={false} maxLength={120} />
        <Field testID="payments-upi-payee" label={t('payments.upi.payee')} value={form.values.upiPayee} onChangeText={form.set('upiPayee')} maxLength={120} />
        <ActionMessages action={action} testID="payments-upi-action" />
        <Button testID="payments-upi-save" kind="secondary" label={t('payments.upi.save')} disabled={!writable} busy={action.busy === 'upi'} onPress={() => { save(); }} />
      </Card>
    </Section>
  );
}
