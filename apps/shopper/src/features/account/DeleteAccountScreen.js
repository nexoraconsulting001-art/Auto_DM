/** Delete my account (Apple 5.1.1(v), P-30): what goes, what the law makes us keep, and one deliberate confirmation. */
import React, { useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Banner, Button, ConfirmSheet, Screen, Text } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBrandName } from '../../shell/parts.js';
import { NeedSignIn, Problem, useSessionState } from '../cart/ui.js';

export default function DeleteAccountScreen() {
  const { t } = useStrings();
  const navigation = useNavigation();
  const brand = useBrandName();
  const { session } = useServices();
  const state = useSessionState();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  async function erase() {
    setBusy(true);
    setError(null);
    try {
      setDone(await session.deleteAccount());
      setAsking(false);
    } catch (failed) {
      setError(failed);
      setAsking(false);
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <Screen testID="screen-account-deleted" title={t('account.deletedTitle')}>
        <Banner testID="deleted-message" tone="good">{done.message || t('account.deletedBody')}</Banner>
        <Button testID="deleted-home" label={t('account.backToStore')} onPress={() => navigation.navigate('home.index')} />
      </Screen>
    );
  }
  if (state.status !== 'signedIn') {
    return (
      <Screen testID="screen-account-delete" title={t('account.deleteTitle')}>
        <NeedSignIn go={(name) => navigation.navigate(name)} />
      </Screen>
    );
  }
  return (
    <Screen testID="screen-account-delete" title={t('account.deleteTitle')}>
      <Text variant="body">{t('account.deleteBody', { brand })}</Text>
      <Text variant="small">{t('account.deleteKeep')}</Text>
      <Problem inline error={error} />
      <Button testID="delete-start" kind="danger" label={t('account.delete')} onPress={() => setAsking(true)} />
      <Button testID="delete-cancel" kind="quiet" label={t('account.close')} onPress={() => navigation.goBack()} />
      <ConfirmSheet visible={asking} title={t('account.deleteSure')} confirmLabel={t('account.deleteConfirm')} cancelLabel={t('account.close')} busy={busy} onConfirm={erase} onCancel={() => setAsking(false)} testID="delete-sheet">
        {t('account.deleteSureBody')}
      </ConfirmSheet>
    </Screen>
  );
}
