import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { errorKey, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Choices, Field, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { PINCODE, STATE_OPTIONS, shippingBody, shippingForm } from '../orders/kit/forms.js';
import { ActionMessages, Offline, PickerField, RecordView, SecretField, useAction, useForm, useProblem, useWritable } from '../orders/kit/ui.js';

export const SHIPPING = ['shipping', 'settings'];

/**
 * Shipping (PRD 9.10, 10.4; P-17): the courier account (the platform's, or the business's own Shiprocket account with
 * its API email and a password that is written once and never read back), the pickup address printed on labels, and a
 * PIN code check. Every save of these settings needs a fresh check, because it can carry courier credentials.
 */
export default function ShippingScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const settings = useQuery({ queryKey: SHIPPING, queryFn: () => api.shippingSettings.get() });
  return (
    <Screen testID="screen-shipping" title={t('shipping.title')}>
      <Offline />
      <RecordView query={settings} testID="shipping-settings">
        {(data) => <SettingsForm key={JSON.stringify(data)} settings={data} />}
      </RecordView>
      <Serviceability />
    </Screen>
  );
}

function SettingsForm({ settings }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const writable = useWritable();
  const form = useForm(shippingForm(settings));
  const problem = useProblem(form.problems);
  const action = useAction([SHIPPING]);
  const [password, setPassword] = useState('');
  const { values, set } = form;

  async function save() {
    const built = shippingBody(values, { ownPassword: password });
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    // The password leaves the field whatever the answer: it is never kept to be sent again.
    const typed = password;
    setPassword('');
    await action.run('save', () => api.shippingSettings.update(built.body), { fresh: true, done: typed ? 'shipping.savedWithPassword' : 'shipping.saved' });
  }

  return (
    <View style={{ gap: theme.space[4] }}>
      <Section title={t('shipping.account')} testID="shipping-account">
        <Card>
          <Choices testID="shipping-mode" label={t('shipping.account')} value={values.mode} onChange={set('mode')} options={[{ value: 'managed', label: t('shipping.mode.managed') }, { value: 'own', label: t('shipping.mode.own') }]} />
          <Text variant="small">{t(`shipping.mode.${values.mode}.note`)}</Text>
          {values.mode !== settings.mode ? <Banner tone="info" testID="shipping-mode-changed">{t('shipping.modeChanged')}</Banner> : null}
          {values.mode === 'managed' ? (
            <Choices testID="shipping-billing" label={t('shipping.billing')} value={values.chargeBilling} onChange={set('chargeBilling')} options={[{ value: 'payout', label: t('shipping.billing.payout') }, { value: 'monthly', label: t('shipping.billing.monthly') }]} />
          ) : (
            <>
              <Field testID="shipping-own-email" label={t('shipping.own.email')} value={values.ownEmail} onChangeText={set('ownEmail')} error={problem('ownEmail')} keyboardType="email-address" autoCapitalize="none" autoComplete="off" autoCorrect={false} maxLength={120} />
              <SecretField testID="shipping-own-password" label={t('shipping.own.password')} saved={settings.ownPasswordSet} value={password} onChangeText={setPassword} />
            </>
          )}
        </Card>
      </Section>
      <Section title={t('shipping.pickup')} action={<Badge testID="shipping-registered" tone={settings.pickupRegistered ? 'good' : 'warn'} label={t(settings.pickupRegistered ? 'shipping.registered' : 'shipping.notRegistered')} />} testID="shipping-pickup">
        <Card>
          <Text variant="small">{t('shipping.pickupIntro')}</Text>
          <Field testID="shipping-pickup-name" label={t('shipping.pickup.name')} value={values.pickupName} onChangeText={set('pickupName')} error={problem('pickupName')} maxLength={80} />
          <Field testID="shipping-pickup-phone" label={t('shipping.pickup.phone')} value={values.pickupPhone} onChangeText={set('pickupPhone')} error={problem('pickupPhone')} keyboardType="phone-pad" maxLength={16} />
          <Field testID="shipping-pickup-line1" label={t('shipping.pickup.line1')} value={values.pickupLine1} onChangeText={set('pickupLine1')} error={problem('pickupLine1')} maxLength={200} />
          <Field testID="shipping-pickup-line2" label={t('shipping.pickup.line2')} value={values.pickupLine2} onChangeText={set('pickupLine2')} maxLength={200} />
          <Field testID="shipping-pickup-city" label={t('shipping.pickup.city')} value={values.pickupCity} onChangeText={set('pickupCity')} error={problem('pickupCity')} maxLength={60} />
          <PickerField testID="shipping-pickup-state" label={t('shipping.pickup.state')} value={values.pickupStateCode} onChange={set('pickupStateCode')} error={problem('pickupStateCode')} options={STATE_OPTIONS.map(([value, label]) => ({ value, label }))} />
          <Field testID="shipping-pickup-pincode" label={t('shipping.pickup.pincode')} value={values.pickupPincode} onChangeText={(text) => set('pickupPincode')(text.replace(/\D/g, '').slice(0, 6))} error={problem('pickupPincode')} keyboardType="number-pad" maxLength={6} />
        </Card>
      </Section>
      <ActionMessages action={action} testID="shipping-action" />
      <Text variant="meta">{t('settings.secret.fresh')}</Text>
      <Button testID="shipping-save" label={t('shipping.save')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
    </View>
  );
}

/** Can the courier reach a PIN code, and is cash on delivery offered there. A read, so it works with any role here. */
function Serviceability() {
  const { api } = useServices();
  const { t } = useStrings();
  const [pin, setPin] = useState('');
  const [asked, setAsked] = useState('');
  const [error, setError] = useState('');
  const result = useQuery({ queryKey: ['shipping', 'serviceability', asked], queryFn: () => api.shipping.serviceability({ pincode: asked }), enabled: Boolean(asked), meta: { offline: false } });

  function check() {
    const value = pin.trim();
    if (!PINCODE.test(value)) return setError(t('shipping.problem.pincode'));
    setError('');
    return setAsked(value);
  }

  return (
    <Section title={t('shipping.check')} testID="shipping-check">
      <Card>
        <Field testID="shipping-check-pin" label={t('shipping.check.pin')} value={pin} onChangeText={(text) => setPin(text.replace(/\D/g, '').slice(0, 6))} error={error || undefined} keyboardType="number-pad" maxLength={6} onSubmitEditing={check} />
        <Button testID="shipping-check-go" kind="secondary" label={t('shipping.check.go')} busy={result.isFetching} onPress={check} />
        {asked && result.data ? (
          <Banner testID="shipping-check-result" tone={result.data.serviceable ? 'good' : 'warn'} title={result.data.pincode}>
            {[result.data.message || t(result.data.serviceable ? 'shipping.check.yes' : 'shipping.check.no'), result.data.serviceable ? t(result.data.cod ? 'shipping.check.cod' : 'shipping.check.noCod') : ''].filter(Boolean).join(' ')}
          </Banner>
        ) : null}
        {asked && result.error && !result.data ? <Banner tone="bad" testID="shipping-check-error">{t(errorKey(result.error))}</Banner> : null}
      </Card>
    </Section>
  );
}
