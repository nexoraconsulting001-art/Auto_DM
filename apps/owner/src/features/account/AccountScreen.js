import React, { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { useNavigation } from '@react-navigation/native';
import { LOCALES, OfflineBanner, methodLabel, useOnline, useReauth, useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Choices, Divider, Field, ListRow, Screen, Section, Sheet, Text, Toggle } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { createLinking, looksLikePhone } from '../../shell/sign-in.js';
import { signOutEverywhere } from '../../shell/sign-out.js';
import { BusinessBadge } from '../../shell/BusinessBadge.js';

const LANGUAGE_NAMES = { en: 'English', hi: 'हिन्दी' };

// Handlers here start their work and return nothing: a fresh check they may open is answered by later presses.

/** Why a link did not happen, as a string key. A cancel says nothing. */
const linkProblem = (error) => (error?.code === 'cancelled' ? '' : error?.code === 'conflict' ? 'account.linkConflict' : error?.status === 0 ? 'error.network' : 'account.linkFailed');

/** Fingerprint or face unlock, on or off. Turning it on proves the person can pass it, then keeps the device's unlock secret. */
function LockSetting() {
  const { api, lock, store } = useServices();
  const { runFresh } = useReauth();
  const { t } = useStrings();
  const online = useOnline();
  const [state, setState] = useState({ on: false, available: false, kind: null, loaded: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([lock.enabled(), lock.available(), lock.kind()]).then(([on, available, kind]) => live && setState({ on, available, kind, loaded: true })).catch(() => {});
    return () => {
      live = false;
    };
  }, [lock]);

  const method = methodLabel(t, state.kind);
  async function change(next) {
    setBusy(true);
    setFailed(false);
    try {
      if (!next) {
        await lock.disable();
      } else {
        const passed = await lock.enable(t('lock.prompt', { app: t('account.title') }), { cancelLabel: t('common.cancel') });
        if (!passed.ok) {
          if (passed.reason !== 'cancelled') setFailed(true);
          return;
        }
        // The unlock secret lets the same fingerprint confirm sensitive changes; it needs a fresh session.
        if (online) {
          const answer = await runFresh(() => api.auth.enableDeviceUnlock()).catch(() => null);
          if (answer?.deviceSecret) await store.setDeviceSecret(answer.deviceSecret);
        }
      }
      setState((s) => ({ ...s, on: next }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Toggle
        testID="account-lock"
        title={t('account.lock', { method })}
        subtitle={!state.available ? t('account.lockUnavailable') : state.on ? t('account.lockOn', { method }) : t('account.lockOff')}
        value={state.on}
        disabled={!state.loaded || busy || (!state.available && !state.on)}
        onValueChange={(next) => { change(next); }}
      />
      {failed ? <Banner tone="bad" testID="account-lock-failed">{t('account.lockFailed')}</Banner> : null}
    </>
  );
}

/** A WhatsApp number added to the account: the number, a code to it, the code back. */
function AddPhoneSheet({ visible, onClose, linking, onLinked }) {
  const { runFresh } = useReauth();
  const { t } = useStrings();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('number');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!visible) {
      setPhone('');
      setCode('');
      setStep('number');
      setProblem('');
    }
  }, [visible]);

  async function send() {
    if (!looksLikePhone(phone)) return setProblem('signIn.badPhone');
    setBusy(true);
    setProblem('');
    try {
      await runFresh(() => linking.startPhone(phone));
      setStep('code');
    } catch (error) {
      setProblem(linkProblem(error));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    setProblem('');
    try {
      const answer = await runFresh(() => linking.verifyPhone(phone, code));
      onLinked(answer);
    } catch (error) {
      setProblem(error?.status === 401 || error?.status === 400 ? 'reauth.failed' : linkProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet testID="account-phone" visible={visible} onClose={onClose} closeLabel={t('common.cancel')} dismissable={!busy} title={t('account.phone.title')}>
      {problem ? <Banner tone="bad" testID="account-phone-problem">{t(problem)}</Banner> : null}
      {step === 'number' ? (
        <>
          <Field testID="account-phone-number" label={t('account.phone.number')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" maxLength={20} />
          <Button testID="account-phone-send" label={t('account.phone.send')} onPress={() => { send(); }} busy={busy} disabled={!phone.trim()} />
        </>
      ) : (
        <>
          <Field testID="account-phone-code" label={t('account.phone.code')} value={code} onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} />
          <Button testID="account-phone-add" label={t('account.phone.add')} onPress={() => { add(); }} busy={busy} disabled={code.length < 6} />
        </>
      )}
    </Sheet>
  );
}

/**
 * Your account. Who you are in the business in use (the business only as its workspace badge), the lock, the ways
 * you sign in, the language, signing out, and the way to Delete my account. `native` and `platform` are for tests.
 */
export default function AccountScreen({ native = { crypto: Crypto, browser: WebBrowser, apple: AppleAuthentication }, platform = Platform.OS }) {
  const { session, store, strings, config } = useServices();
  const { user, business, offline } = useSession();
  const online = useOnline() && !offline;
  const { runFresh } = useReauth();
  const navigation = useNavigation();
  const openLink = useOpenLink();
  const { t, locale } = useStrings();
  const linking = useMemo(() => createLinking({ session, config, ...native }), [session, config, native]);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [identities, setIdentities] = useState(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  const [signOutFailed, setSignOutFailed] = useState(false);

  async function signOut() {
    setSignOutFailed(false);
    try {
      await signOutEverywhere({ session, store });
    } catch {
      setSignOutFailed(true); // the server was not reached: still signed in, and it says so
    }
  }

  function linked(answer) {
    setPhoneOpen(false);
    setProblem('');
    setIdentities(answer?.identities ?? []);
  }

  async function link(name, work) {
    setBusy(name);
    setProblem('');
    try {
      linked(await runFresh(work));
    } catch (error) {
      setProblem(linkProblem(error));
    } finally {
      setBusy('');
    }
  }

  async function chooseLanguage(next) {
    strings.setLocale(next);
    await store.setLocale(next);
  }

  return (
    <Screen testID="screen-account" title={t('account.title')}>
      <OfflineBanner offline={!online} />
      <Card>
        <ListRow
          testID="account-who"
          title={user?.name ?? ''}
          subtitle={t('account.here', { role: user?.role ? t(`role.${user.role}`) : '', business: business?.name ?? '' })}
          start={<BusinessBadge business={business} />}
        />
      </Card>

      <Section title={t('account.security')}>
        <Card>
          <LockSetting />
        </Card>
      </Section>

      <Section title={t('account.ways')}>
        <Card>
          <Text variant="small">{t('account.waysBody')}</Text>
          {problem ? <Banner tone="bad" testID="account-link-problem">{t(problem)}</Banner> : null}
          {identities ? (
            <View testID="account-identities" accessible accessibilityRole="summary">
              <Text variant="small">{t('account.linked')}</Text>
              {identities.map((identity) => <Text key={`${identity.kind}-${identity.label}`} variant="meta">{identity.label}</Text>)}
            </View>
          ) : null}
          <Button testID="account-add-phone" kind="secondary" label={t('account.addPhone')} disabled={!online || Boolean(busy)} onPress={() => setPhoneOpen(true)} />
          <Button testID="account-link-google" kind="secondary" label={t('account.linkGoogle')} busy={busy === 'google'} disabled={!online || Boolean(busy)} onPress={() => { link('google', linking.google); }} />
          {platform === 'ios' ? <Button testID="account-link-apple" kind="secondary" label={t('account.linkApple')} busy={busy === 'apple'} disabled={!online || Boolean(busy)} onPress={() => { link('apple', linking.apple); }} /> : null}
        </Card>
      </Section>

      <Section title={t('account.language')}>
        <Choices testID="account-language" label={t('account.languageLabel')} value={locale} onChange={chooseLanguage} options={LOCALES.map((value) => ({ value, label: LANGUAGE_NAMES[value] ?? value }))} />
      </Section>

      <Section title={t('account.more')}>
        <Card>
          <ListRow testID="account-devices" title={t('devices.title')} onPress={() => openLink('/settings/devices')} />
          <Divider />
          <ListRow testID="account-notifications" title={t('notifications.settings')} onPress={() => openLink('/notifications/settings')} />
        </Card>
      </Section>

      {signOutFailed ? <Banner tone="bad" testID="account-sign-out-failed">{t('account.signOutFailed')}</Banner> : null}
      <Button testID="account-sign-out" kind="secondary" label={t('account.signOut')} onPress={() => { signOut(); }} />
      <Button testID="account-delete" kind="danger" label={t('account.delete')} onPress={() => navigation.navigate('account.delete')} />
      <AddPhoneSheet visible={phoneOpen} onClose={() => setPhoneOpen(false)} linking={linking} onLinked={linked} />
    </Screen>
  );
}
