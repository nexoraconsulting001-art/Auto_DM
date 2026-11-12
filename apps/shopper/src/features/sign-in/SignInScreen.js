/** Sign in with Google, a WhatsApp code, or on iOS Apple. A guest never has to: this screen is only opened by choice. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Banner, Button, Field, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBootstrap } from '../../shell/data.js';
import { useBrandName } from '../../shell/parts.js';
import { Problem, useSessionState } from '../cart/ui.js';

export default function SignInScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const brand = useBrandName();
  const { session, config } = useServices();
  const state = useSessionState();
  const bootstrap = useBootstrap();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');

  const options = bootstrap.data?.signIn ?? { whatsapp: true, google: true, apple: false };
  const apple = config.app.platform === 'ios' && options.apple !== false;

  const done = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('account.index'));

  async function run(task) {
    setBusy(true);
    setError(null);
    setNote('');
    try {
      const result = await task();
      if (result?.signedIn === false) setNote(result.reason === 'cancelled' ? t('sign-in.cancelled') : t('sign-in.failed'));
      else if (result !== undefined || session.getState().status === 'signedIn') done();
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'signedIn') {
    return (
      <Screen testID="screen-sign-in" title={t('sign-in.title')}>
        <Button testID="sign-in-done" label={t('sign-in.back')} onPress={done} />
      </Screen>
    );
  }
  return (
    <Screen testID="screen-sign-in" title={t('sign-in.heading', { brand })}>
      <Text variant="body">{t('sign-in.body')}</Text>
      {note ? <Banner testID="sign-in-note" tone="warn">{note}</Banner> : null}
      <Problem inline error={error} />
      <View style={{ gap: theme.space[3] }}>
        {options.google !== false ? (
          <Button testID="sign-in-google" kind="secondary" label={t('sign-in.google')} busy={busy} onPress={() => run(() => session.signInWithGoogle({ browser: require('expo-web-browser') }))} />
        ) : null}
        {apple ? (
          <Button testID="sign-in-apple" kind="secondary" label={t('sign-in.apple')} busy={busy} onPress={() => run(() => session.signInWithApple({ apple: require('expo-apple-authentication'), sha256Hex: session.sha256Hex }))} />
        ) : null}
      </View>
      {options.whatsapp !== false ? (
        <View style={{ gap: theme.space[3] }}>
          <Field testID="sign-in-phone" label={t('sign-in.phone')} hint={t('sign-in.phoneHint')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" editable={!busy} />
          {sent ? (
            <>
              <Field testID="sign-in-code" label={t('sign-in.code')} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="sms-otp" maxLength={6} />
              <Button testID="sign-in-verify" label={t('sign-in.verify')} busy={busy} disabled={code.length !== 6} onPress={() => run(async () => { await session.signInWithCode(phone, code); return { signedIn: true }; })} />
              <Button testID="sign-in-resend" kind="quiet" label={t('sign-in.resend')} disabled={busy} onPress={() => run(async () => { await session.sendCode(phone); return undefined; })} />
            </>
          ) : (
            <Button testID="sign-in-send" label={t('sign-in.sendCode')} busy={busy} disabled={phone.replace(/\D/g, '').length < 8} onPress={() => run(async () => { await session.sendCode(phone); setSent(true); return undefined; })} />
          )}
        </View>
      ) : null}
      <Button testID="sign-in-cancel" kind="quiet" label={t('sign-in.back')} onPress={done} />
    </Screen>
  );
}
