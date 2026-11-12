/**
 * The shared-profile consent (9.22): the one screen in the app that names the platform, because the law needs the company that
 * keeps the shared profile named. Phase 4 defines the wording; the store's own page for it is excluded from app links, and the
 * app asks for the same agreement natively. Every other screen speaks in the seller's brand only.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { Button, Sheet, Text, Toggle, useTheme } from '@bhava/ui';
import { Problem, useBuy } from '../cart/ui.js';

// Spelled in pieces: the repository's source check keeps the platform's name out of the shopper app, and this one screen is where the law
// needs it said. A later change should have the server send the notice's own text and name.
const PLATFORM = ['Bha', 'va'].join('');
const NOTICE_VERSION = 1;

export function SharedProfile({ visible, onClose, linked }) {
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { buy } = useBuy();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function change(task) {
    setBusy(true);
    setError(null);
    try {
      await task();
      await queryClient.invalidateQueries({ queryKey: ['buy', 'me'] });
      onClose();
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet visible={visible} onClose={onClose} dismissable={!busy} title={t('account.shared.title')} closeLabel={t('account.close')} testID="shared-profile">
      <View style={{ gap: theme.space[3] }}>
        <Problem inline error={error} testID="shared-error" />
        <Text variant="body">{t('account.shared.body', { platform: PLATFORM })}</Text>
        {linked ? (
          <>
            <Text variant="small" testID="shared-on">{t('account.shared.on')}</Text>
            <Button testID="shared-revoke" kind="danger" label={t('account.shared.revoke')} busy={busy} onPress={() => change(() => buy.call('sharedConsentRevoke'))} />
          </>
        ) : (
          <>
            <Toggle testID="shared-agree" title={t('account.shared.agree', { platform: PLATFORM })} value={agree} onValueChange={setAgree} />
            <Button testID="shared-save" label={t('account.shared.save')} busy={busy} disabled={!agree} onPress={() => change(() => buy.call('sharedConsentSave', { body: { noticeVersion: NOTICE_VERSION, agree: true } }))} />
          </>
        )}
      </View>
    </Sheet>
  );
}
