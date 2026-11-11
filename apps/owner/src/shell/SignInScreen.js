import React, { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useStrings } from '@bhava/app-core';
import { Banner, Button, Field, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../services.js';
import { APP_NAME } from '../strings.js';
import { createSignIn, signInOptions, signInProblem } from './sign-in.js';

const logo = require('../../assets/logo.png');

/**
 * Sign-in: WhatsApp code, Google, and Apple on iOS. No password field and no SMS (P-11). The platform's own name
 * and mark throughout: no business is known yet.
 */
export function SignInScreen({ platform = Platform.OS, native = { crypto: Crypto, browser: WebBrowser, apple: AppleAuthentication } }) {
  const { session, config, configError } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const [requirements, setRequirements] = useState(null);
  const [step, setStep] = useState('choose'); // choose, phone, code
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState(session?.getState().signedOutReason === 'expired' ? 'signedOut.expired' : '');

  const signIn = useMemo(() => (session ? createSignIn({ session, config, ...native }) : null), [session, config, native]);
  const options = signInOptions(requirements, platform);

  useEffect(() => {
    let live = true;
    session?.api.app.requirements({ app: 'owner', platform: config.app.platform }).then((answer) => live && setRequirements(answer)).catch(() => {});
    return () => {
      live = false;
    };
  }, [session, config]);

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

  if (configError || !signIn) {
    return (
      <Screen testID="sign-in">
        <Banner tone="bad" testID="sign-in-not-configured">{t('signIn.notConfigured')}</Banner>
      </Screen>
    );
  }

  return (
    <Screen testID="sign-in">
      <View style={{ gap: theme.space[2], paddingTop: theme.space[8] }}>
        <Image source={logo} accessibilityLabel={APP_NAME} contentFit="contain" style={{ width: 132, height: 33 }} />
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
          <Field testID="sign-in-phone" label={t('signIn.phone')} hint={t('signIn.phoneHint')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" />
          <Button testID="sign-in-send" label={t('signIn.sendCode')} busy={busy === 'start'} disabled={!phone.trim()} onPress={() => run('start', async () => { await signIn.startCode(phone); setStep('code'); })} />
          <Button testID="sign-in-other" kind="quiet" label={t('common.cancel')} onPress={() => setStep('choose')} />
        </View>
      ) : null}

      {step === 'code' ? (
        <View style={{ gap: theme.space[3] }}>
          <Field testID="sign-in-code" label={t('signIn.code')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} />
          <Button testID="sign-in-verify" label={t('signIn.verify')} busy={busy === 'verify'} disabled={code.trim().length < 6} onPress={() => run('verify', () => signIn.verifyCode(phone, code))} />
          <Text variant="small">{t('signIn.noCode')}</Text>
          <Button testID="sign-in-back" kind="quiet" label={t('signIn.back')} onPress={() => { setCode(''); setStep('choose'); }} />
        </View>
      ) : null}
    </Screen>
  );
}
