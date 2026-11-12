/** The three notification choices, each its own opt-in: Order updates, Offers, New reels (P-48, P-62). Offers and New reels start off. */
import React, { useState } from 'react';
import { Linking } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { Banner, Button, LoadingRows, Screen, Toggle } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBrandName } from '../../shell/parts.js';
import { Problem, useStoreQuery } from '../cart/ui.js';

export default function NotificationsScreen() {
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const brand = useBrandName();
  const { notifications } = useServices();
  const prefs = useStoreQuery(['push-prefs'], () => notifications.prefs());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [refused, setRefused] = useState(false);
  const data = prefs.data;

  async function turn(name, value) {
    setBusy(true);
    setError(null);
    setRefused(false);
    try {
      // Off is always allowed. On needs the phone's permission, asked here, at the shopper's own request.
      const result = value ? await notifications.enable({ [name]: true }) : { saved: true, prefs: await notifications.save({ [name]: false }) };
      if (result.saved) queryClient.setQueryData(['buy', 'push-prefs'], result.prefs);
      else setRefused(true);
      await queryClient.invalidateQueries({ queryKey: ['buy', 'push-prefs'] });
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen testID="screen-notifications" title={t('notifications.title')}>
      {prefs.isError && !data ? <Problem error={prefs.error} onRetry={() => prefs.refetch()} /> : null}
      {prefs.isPending ? <LoadingRows rows={3} label={t('home.common.loading')} testID="notifications-loading" /> : null}
      <Problem inline error={error} />
      {data && (data.permission === 'denied' || refused) ? (
        <Banner testID="notifications-denied" tone="warn" action={<Button kind="secondary" label={t('notifications.settings')} onPress={() => Linking.openSettings()} />}>{t('notifications.denied')}</Banner>
      ) : null}
      {data ? (
        <>
          <Toggle testID="toggle-order" title={t('notifications.order')} subtitle={t('notifications.orderSub')} value={data.orderUpdates} disabled={busy} onValueChange={(v) => turn('orderUpdates', v)} />
          <Toggle testID="toggle-offers" title={t('notifications.offers')} subtitle={t('notifications.offersSub')} value={data.offers} disabled={busy} onValueChange={(v) => turn('offers', v)} />
          <Toggle testID="toggle-reels" title={t('notifications.reels')} subtitle={t('notifications.reelsSub', { brand })} value={data.newReels} disabled={busy} onValueChange={(v) => turn('newReels', v)} />
        </>
      ) : null}
    </Screen>
  );
}
