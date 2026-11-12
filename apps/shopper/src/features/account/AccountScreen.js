/** The shopper's own page: sign in or out, orders, wishlist, addresses, rewards, notifications, the shared profile, and Delete my account. */
import React, { useState } from 'react';
import { Linking, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Button, Card, ConfirmSheet, ListRow, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBootstrap } from '../../shell/data.js';
import { useBrandName } from '../../shell/parts.js';
import { Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';
import { SharedProfile } from './SharedProfile.js';

export default function AccountScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const brand = useBrandName();
  const { session } = useServices();
  const { buy } = useBuy();
  const state = useSessionState();
  const bootstrap = useBootstrap();
  const signedIn = state.status === 'signedIn';
  const me = useStoreQuery(['me', state.status], () => buy.call('appMe'), { enabled: state.status !== 'starting' });
  const [leaving, setLeaving] = useState(false);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const go = (name) => () => navigation.navigate(name);
  const support = bootstrap.data?.supportEmail;
  const sharedProfile = me.data?.sharedProfile;

  async function signOut() {
    setBusy(true);
    try {
      await session.signOut();
      setLeaving(false);
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen testID="screen-account" title={t('account.title')}>
      <Problem inline error={error} />
      <Card testID="account-who">
        {signedIn ? (
          <View style={{ gap: theme.space[1] }}>
            <Text variant="title" testID="account-name">{state.shopper?.name || t('account.welcome', { brand })}</Text>
            {state.shopper?.phoneMasked ? <Text variant="small" testID="account-phone">{state.shopper.phoneMasked}</Text> : null}
            {state.shopper?.email ? <Text variant="small">{state.shopper.email}</Text> : null}
          </View>
        ) : (
          <View style={{ gap: theme.space[3] }}>
            <Text variant="title">{t('account.guestTitle', { brand })}</Text>
            <Text variant="small">{t('account.guestBody')}</Text>
            <Button testID="account-sign-in" label={t('account.signIn')} onPress={go('sign-in.index')} />
          </View>
        )}
      </Card>
      <Section title={t('account.yours')}>
        <ListRow testID="row-orders" title={t('account.orders')} onPress={go('orders.index')} />
        <ListRow testID="row-wishlist" title={t('account.wishlist')} onPress={go('wishlist.index')} />
        <ListRow testID="row-addresses" title={t('account.addresses')} onPress={go('addresses.index')} />
        <ListRow testID="row-rewards" title={t('account.rewards')} onPress={go('rewards.index')} />
        <ListRow testID="row-notifications" title={t('account.notifications')} onPress={go('notifications.index')} />
        {signedIn && sharedProfile?.available ? <ListRow testID="row-shared" title={t('account.shared.row')} subtitle={sharedProfile.linked ? t('account.shared.on') : t('account.shared.off')} onPress={() => setShared(true)} /> : null}
        {support ? <ListRow testID="row-support" title={t('account.support')} subtitle={support} onPress={() => Linking.openURL(`mailto:${support}`)} /> : null}
      </Section>
      {signedIn ? (
        <View style={{ gap: theme.space[2] }}>
          <Button testID="account-sign-out" kind="secondary" label={t('account.signOut')} onPress={() => setLeaving(true)} />
          <Button testID="account-delete" kind="danger" label={t('account.delete')} onPress={go('account.delete')} />
        </View>
      ) : null}
      <ConfirmSheet visible={leaving} tone="primary" title={t('account.signOutTitle')} confirmLabel={t('account.signOut')} cancelLabel={t('account.close')} busy={busy} onConfirm={signOut} onCancel={() => setLeaving(false)} testID="sign-out-sheet">
        {t('account.signOutBody')}
      </ConfirmSheet>
      <SharedProfile visible={shared} onClose={() => setShared(false)} linked={Boolean(sharedProfile?.linked)} />
    </Screen>
  );
}
