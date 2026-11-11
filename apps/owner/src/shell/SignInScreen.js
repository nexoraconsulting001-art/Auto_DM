import React, { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { maskPhoneNumber, useStrings } from '@bhava/app-core';
import { Banner, Button, Field, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../services.js';
import { APP_NAME } from '../strings.js';
import { useStoredLocale } from './locale.js';
import { createSignIn, looksLikePhone, signInOptions, signInProblem } from './sign-in.js';

const logo = require('../../assets/logo.png');

/** What the sign-in screen says about the last session, by the reason it ended. */
const ENDED = { expired: 'signedOut.expired', removed: 'signedOut.removed', account_deleted: 'signedOut.account_deleted' };

/**
 * Sign-in: WhatsApp code, Google, and Apple on iOS. No password field and no SMS (P-11). The platform's own name
 * and mark throughout: no business is known yet. A code that does not come can be sent again after the wait the
 * server names, or the person takes Google (or Apple) instead: there is never a text-message fallback (F-118).
 *
 * The number typed is held on this screen only, and shown back masked; it is never stored or logged.
 */
export function SignInScreen({ platform = Platform.OS, native = { crypto: Crypto, browser: WebBrowser, apple: AppleAuthentication }, now = () => Date.now() }) {
  const { session, config, configError, store, strings } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const [requirements, setRequirements] = useState(null);
  const [step, setStep] = useState('choose'); // choose, phone, code
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState(ENDED[session?.getState().signedOutReason] ?? '');
  const [sent, setSent] = useState(null); // { alternatives, resendAt }
  const [clock, setClock] = useState(now());

  const signIn = useMemo(() => (session ? createSignIn({ session, config, ...native }) : null), [session, config, native]);
  const options = signInOptions(requirements, platform);
  useStoredLocale(store, strings);

  useEffect(() => {
    let live = true;
    session?.api.app.requirements({ app: 'owner', platform: config.app.platform }).then((answer) => live && setRequirements(answer)).catch(() => {});
    return () => {
      live = false;
    };
  }, [session, config]);

  // The resend button wakes when the server's wait is over.
  const waitLeft = sent ? Math.max(0, Math.ceil((sent.resendAt - clock) / 1000)) : 0;
  useEffect(() => {
    if (!sent || waitLeft <= 0) return undefined;
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
  }, [sent, waitLeft, now]);

  async function run(name, work) {
    setBusy(name);
    setProblem('');
    try {
      await work();
    } catch (error) {
      setProblem(signInProblem(error));
    } finally {
      setBusy('');
    }
  }

  async function sendCode() {
    if (!looksLikePhone(phone)) {
      setProblem('signIn.badPhone');
      return;
    }
    await run('start', async () => {
      const answer = await signIn.startCode(phone);
      setSent({ alternatives: answer?.alternatives ?? [], resendAt: now() + (answer?.resendInSeconds ?? 30) * 1000 });
      setClock(now());
      setStep('code');
    });
  }

  if (configError || !signIn) {
    return (
      <Screen testID="sign-in">
        <Banner tone="bad" testID="sign-in-not-configured">{t('signIn.notConfigured')}</Banner>
      </Screen>
    );
  }

  const alternatives = sent?.alternatives ?? ['google'];
  const offerGoogle = options.google && alternatives.includes('google');
  const offerApple = options.apple && alternatives.includes('apple');

  return (
    <Screen testID="sign-in">
      <View style={{ gap: theme.space[2], paddingTop: theme.space[8] }}>
        <Image testID="sign-in-logo" source={logo} accessibilityLabel={APP_NAME} contentFit="contain" style={{ width: 132, height: 33 }} />
        <Text variant="page">{t('signIn.title', { app: APP_NAME })}</Text>
        <Text variant="small">{t('signIn.subtitle')}</Text>
      </View>
      {problem ? <Banner tone="bad" testID="sign-in-problem">{t(problem)}</Banner> : null}

      {step === 'choose' ? (
        <View style={{ gap: theme.space[3] }}>
          {options.whatsapp ? <Button testID="sign-in-whatsapp" label={t('signIn.whatsapp')} onPress={() => setStep('phone')} disabled={Boolean(busy)} /> : null}
          {options.google ? <Button testID="sign-in-google" kind="secondary" label={t('signIn.google')} busy={busy === 'google'} disabled={Boolean(busy)} onPress={() => run('google', signIn.google)} /> : null}
          {options.apple ? <Button testID="sign-in-apple" kind="secondary" label={t('signIn.apple')} busy={busy === 'apple'} disabled={Boolean(busy)} onPress={() => run('apple', signIn.apple)} /> : null}
        </View>
      ) : null}

      {step === 'phone' ? (
        <View style={{ gap: theme.space[3] }}>
          <Field testID="sign-in-phone" label={t('signIn.phone')} hint={t('signIn.phoneHint')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" maxLength={20} />
          <Button testID="sign-in-send" label={t('signIn.sendCode')} busy={busy === 'start'} disabled={!phone.trim()} onPress={sendCode} />
          <Button testID="sign-in-other" kind="quiet" label={t('common.cancel')} onPress={() => setStep('choose')} />
        </View>
      ) : null}

      {step === 'code' ? (
        <View style={{ gap: theme.space[3] }}>
          <Text variant="small" testID="sign-in-sent">{t('signIn.codeSent', { phone: maskPhoneNumber(phone) })}</Text>
          <Field testID="sign-in-code" label={t('signIn.code')} value={code} onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} />
          <Button testID="sign-in-verify" label={t('signIn.verify')} busy={busy === 'verify'} disabled={code.trim().length < 6} onPress={() => run('verify', () => signIn.verifyCode(phone, code))} />
          <Button
            testID="sign-in-resend"
            kind="secondary"
            label={waitLeft > 0 ? t('signIn.resendIn', { seconds: waitLeft }) : t('signIn.resend')}
            disabled={waitLeft > 0 || Boolean(busy)}
            busy={busy === 'start'}
            onPress={sendCode}
          />
          <Text variant="small" testID="sign-in-no-whatsapp">{offerGoogle ? t('signIn.noWhatsApp') : t('signIn.noCode')}</Text>
          {offerGoogle ? <Button testID="sign-in-use-google" kind="secondary" label={t('signIn.useGoogle')} busy={busy === 'google'} disabled={Boolean(busy)} onPress={() => run('google', signIn.google)} /> : null}
          {offerApple ? <Button testID="sign-in-use-apple" kind="secondary" label={t('signIn.useApple')} busy={busy === 'apple'} disabled={Boolean(busy)} onPress={() => run('apple', signIn.apple)} /> : null}
          <Button testID="sign-in-back" kind="quiet" label={t('signIn.back')} onPress={() => { setCode(''); setSent(null); setStep('choose'); }} />
        </View>
      ) : null}
    </Screen>
  );
}
