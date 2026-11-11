/**
 * Screens and banners every app needs whatever it sells: "Update required" (the API answered 426), "No connection",
 * the offline banner over cached lists, and the lock. The app's name is passed in, so nothing here names a brand.
 */
import React from 'react';
import { Linking } from 'react-native';
import { Banner, Button, EmptyState, Screen } from '@bhava/ui';
import { useStrings } from './strings/index.js';

/** Only a store's own https page (or its app scheme) is ever opened: the link comes from the server, but is still checked. */
export const isStoreUrl = (url) => /^(https:\/\/(play\.google\.com|apps\.apple\.com|itunes\.apple\.com)\/|market:\/\/details\?|itms-apps:\/\/)/i.test(String(url ?? ''));

export function UpdateRequiredScreen({ appName, storeUrl, openUrl = Linking.openURL }) {
  const { t } = useStrings();
  return (
    <Screen testID="update-required">
      <EmptyState title={t('update.title')} action={isStoreUrl(storeUrl) ? <Button testID="update-action" label={t('update.action')} onPress={() => openUrl(storeUrl)} /> : null}>
        {t('update.body', { app: appName })}
      </EmptyState>
    </Screen>
  );
}

export function OfflineScreen({ onRetry, busy = false }) {
  const { t } = useStrings();
  return (
    <Screen testID="offline-screen">
      <EmptyState title={t('offline.title')} action={<Button testID="offline-retry" label={t('common.retry')} onPress={onRetry} busy={busy} kind="secondary" />}>
        {t('offline.body')}
      </EmptyState>
    </Screen>
  );
}

/** Above a list that is showing saved rows. Renders nothing while online. */
export function OfflineBanner({ offline }) {
  const { t } = useStrings();
  if (!offline) return null;
  return <Banner testID="offline-banner" tone="warn">{t('offline.banner')}</Banner>;
}

export function LockScreen({ appName, onUnlock, onSignInInstead, failed = false, busy = false }) {
  const { t } = useStrings();
  return (
    <Screen testID="lock-screen">
      <EmptyState
        title={t('lock.title', { app: appName })}
        action={
          <>
            <Button testID="lock-unlock" label={t('lock.action')} onPress={onUnlock} busy={busy} />
            <Button testID="lock-sign-in" label={t('lock.signInInstead')} onPress={onSignInInstead} kind="quiet" />
          </>
        }
      >
        {failed ? t('lock.failed') : null}
      </EmptyState>
    </Screen>
  );
}
