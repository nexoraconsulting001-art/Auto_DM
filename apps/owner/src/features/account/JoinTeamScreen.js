import React, { useState } from 'react';
import { OfflineBanner, useOnline, useStrings } from '@bhava/app-core';
import { Banner, Button, Field, Screen, Text } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';

/**
 * Join a team (PRD 5.11): the person enters the invitation code the owner passed on (auth.acceptInvite). It works only
 * for the number or email that was invited, verified on this account; until then the owner sees nothing about them.
 * The business then shows in the switcher. Needs a connection.
 */
export default function JoinTeamScreen() {
  const { api } = useServices();
  const { offline } = useSession();
  const online = useOnline() && !offline;
  const { t } = useStrings();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [joined, setJoined] = useState(null);

  async function join() {
    setBusy(true);
    setFailed('');
    try {
      const { business } = await api.auth.acceptInvite({ code: code.trim() });
      setJoined(business);
      setCode('');
    } catch (error) {
      setFailed(error?.code === 'not_found' ? t('account.join.notYours') : t('account.join.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen testID="screen-account-join" title={t('account.join.title')}>
      <OfflineBanner offline={!online} />
      <Text variant="body">{t('account.join.body')}</Text>
      {joined ? <Banner tone="good" testID="join-done">{t('account.join.done', { business: joined.name })}</Banner> : null}
      {failed ? <Banner tone="bad" testID="join-failed">{failed}</Banner> : null}
      <Field testID="join-code" label={t('account.join.code')} value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} maxLength={200} />
      <Button testID="join-submit" label={t('account.join.action')} busy={busy} disabled={!online || !code.trim()} onPress={() => { join(); }} />
    </Screen>
  );
}
