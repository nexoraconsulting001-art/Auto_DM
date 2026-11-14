import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { ActionMessages, KeyForm, Offline, RecordView, openOutside, useAction, useAllowed, useForm } from '../orders/kit/ui.js';
import { PICKUP_FIELDS, TERMS_VERSION, checkPickup, progressOf } from './rules.js';

export const SETUP = ['setup'];
const OWN_KEY_PROVIDERS = ['razorpay', 'cashfree', 'shiprocket'];
const TONES = { done: 'good', failed: 'bad', waiting: 'warn', pending: 'neutral' };

/**
 * The setup checklist (PRD 5.6: F-26 to F-31, F-77 to F-80): what still stands between this business and going live, each step
 * checked live by the server, with the one action that fixes it: reconnect Instagram, KYC on Razorpay's own page, the
 * pickup address, your own keys, the domain, or the terms. Only the owner can do these; a manager sees where things stand.
 */
export default function SetupScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const allowed = useAllowed();
  const owner = allowed(OWNER_ONLY);
  const action = useAction([SETUP]);
  const [form, setForm] = useState(null); // 'pickup' | 'keys' | null
  const [askTerms, setAskTerms] = useState(false);
  const query = useQuery({ queryKey: [...SETUP, 'checklist'], queryFn: () => api.setup.get() });

  const check = (step) => action.run(`check:${step ?? 'all'}`, () => api.setup.check(step ? { step } : {}), { done: 'setup.done.checked' });
  const fix = async (step) => {
    switch (step.fix) {
      case 'reconnect': return navigation.navigate('connect.index');
      case 'dns': return navigation.navigate('domains.index');
      case 'pickup': return setForm('pickup');
      case 'keys': return setForm('keys');
      case 'terms': return setAskTerms(true);
      case 'kyc': {
        const link = await action.run('kyc', () => api.setup.kycLink());
        if (link?.url) await openOutside(link.url);
        return undefined;
      }
      default: return undefined;
    }
  };

  return (
    <Screen testID="screen-setup" title={t('setup.title')}>
      <Offline />
      <ActionMessages action={action} testID="setup-action" />
      <RecordView query={query} testID="setup">
        {(data) => {
          const progress = progressOf(data.steps);
          return (
            <View style={{ gap: theme.space[3] }}>
              <Card testID="setup-summary">
                <Text variant="title">{data.done ? t('setup.allDone') : t('setup.progress', { done: progress.done, total: progress.total })}</Text>
                {!data.done ? <Text variant="small">{t('setup.intro')}</Text> : null}
                {!data.checkoutOpen && data.steps.some((s) => s.step === 'payments') ? <Banner tone="warn" testID="setup-checkout-closed">{t('setup.checkoutClosed')}</Banner> : null}
                {data.kyc ? <Text variant="small" testID="setup-kyc">{t(`setup.kyc.${data.kyc.status}`)}{data.kyc.reason ? ` ${data.kyc.reason}` : ''}</Text> : null}
                <Button testID="setup-check-all" kind="secondary" label={t('setup.checkAll')} disabled={!action.writable} busy={action.busy === 'check:all'} onPress={() => check(null)} />
              </Card>
              <Card testID="setup-steps">
                {data.steps.map((step, i) => (
                  <View key={step.step} testID={`setup-step-${step.step}`} style={{ gap: theme.space[1], paddingVertical: theme.space[2] }}>
                    {i > 0 ? <Divider /> : null}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
                      <Text variant="body" style={{ flex: 1, fontFamily: theme.font.bodySemiBold }}>{t(`setup.step.${step.step}`)}</Text>
                      {!step.required ? <Badge label={t('setup.optional')} tone="neutral" /> : null}
                      <Badge testID={`setup-step-${step.step}-status`} label={t(`setup.status.${step.status}`)} tone={TONES[step.status] ?? 'neutral'} />
                    </View>
                    {step.status !== 'done' && step.reason ? <Text variant="small">{step.reason}</Text> : null}
                    <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
                      {step.status !== 'done' && step.fix && owner ? (
                        <Button testID={`setup-step-${step.step}-fix`} label={t(`setup.fix.${step.fix}`)} disabled={!action.writable && !['reconnect', 'dns'].includes(step.fix)} busy={action.busy === step.fix} onPress={() => fix(step)} />
                      ) : null}
                      {step.status !== 'done' && step.fix && !owner ? <Text variant="meta">{t('setup.askOwner')}</Text> : null}
                      <Button testID={`setup-step-${step.step}-check`} kind="quiet" label={t('setup.check')} disabled={!action.writable} busy={action.busy === `check:${step.step}`} onPress={() => check(step.step)} />
                    </View>
                  </View>
                ))}
              </Card>
              {form === 'pickup' ? <PickupForm onClose={() => setForm(null)} /> : null}
              {form === 'keys' ? <OwnKeysForm onClose={() => setForm(null)} /> : null}
            </View>
          );
        }}
      </RecordView>
      <ConfirmSheet
        testID="setup-terms"
        visible={askTerms}
        tone="primary"
        title={t('setup.terms.title')}
        confirmLabel={t('setup.terms.accept')}
        cancelLabel={t('common.cancel')}
        busy={action.busy === 'terms'}
        onCancel={() => setAskTerms(false)}
        onConfirm={async () => {
          await action.run('terms', () => api.setup.acceptTerms({ version: TERMS_VERSION }), { done: 'setup.done.terms' });
          setAskTerms(false);
        }}
      >
        {t('setup.terms.body')}
      </ConfirmSheet>
    </Screen>
  );
}

function PickupForm({ onClose }) {
  const { api } = useServices();
  const { t } = useStrings();
  const action = useAction([SETUP]);
  const form = useForm(Object.fromEntries(PICKUP_FIELDS.map((f) => [f.name, ''])));
  const submit = async () => {
    const built = checkPickup(form.values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    const done = await action.run('pickup', () => api.setup.pickupAddress(built.body), { done: 'setup.done.pickup' });
    if (done) onClose();
  };
  return (
    <Section title={t('setup.fix.pickup')}>
      <Card testID="setup-pickup">
        {PICKUP_FIELDS.map((f) => (
          <Field
            key={f.name}
            testID={`pickup-${f.name}`}
            label={t(`setup.pickup.${f.name}`)}
            value={form.values[f.name]}
            error={form.problems[f.name] ? t(form.problems[f.name]) : undefined}
            keyboardType={f.keyboardType}
            autoCapitalize={f.name === 'email' ? 'none' : 'words'}
            maxLength={f.max}
            onChangeText={form.set(f.name)}
          />
        ))}
        <ActionMessages action={action} testID="setup-pickup-action" />
        <Button testID="pickup-save" label={t('common.save')} disabled={!action.writable} busy={action.busy === 'pickup'} onPress={submit} />
        <Button testID="pickup-cancel" kind="quiet" label={t('common.cancel')} onPress={onClose} />
      </Card>
    </Section>
  );
}

/** Your own payment or courier keys: a test call runs first, keys that fail it are not saved, and nothing typed is kept (PRD F-79). */
function OwnKeysForm({ onClose }) {
  const { api } = useServices();
  const { t } = useStrings();
  const [provider, setProvider] = useState('razorpay');
  const fields = [
    { name: 'keyId', label: t(provider === 'shiprocket' ? 'setup.keys.email' : 'setup.keys.keyId') },
    { name: 'keySecret', label: t(provider === 'shiprocket' ? 'setup.keys.password' : 'setup.keys.secret'), secret: true },
  ];
  return (
    <Section title={t('setup.fix.keys')}>
      <Card testID="setup-keys">
        <Choices testID="keys-provider" label={t('setup.keys.provider')} value={provider} onChange={setProvider} options={OWN_KEY_PROVIDERS.map((value) => ({ value, label: t(`setup.keys.${value}`) }))} />
        <KeyForm
          testID="keys-form"
          fields={fields}
          required={['keyId', 'keySecret']}
          submitLabel={t('setup.keys.save')}
          intro={t('setup.keys.intro')}
          doneKey="setup.done.keys"
          reload={[SETUP]}
          build={(values) => ({ body: { provider, keyId: values.keyId.trim(), keySecret: values.keySecret } })}
          save={(body) => api.setup.ownKeys(body)}
          onSaved={onClose}
        />
        <Button testID="keys-cancel" kind="quiet" label={t('common.cancel')} onPress={onClose} />
      </Card>
    </Section>
  );
}
