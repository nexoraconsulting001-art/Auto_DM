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

/** The words for a kind of unlock ('face', 'fingerprint' or anything else), to fill {method} in a line. */
export const methodLabel = (t, kind) => t(kind === 'face' ? 'lock.method.face' : kind === 'fingerprint' ? 'lock.method.fingerprint' : 'lock.method.any');

/**
 * The lock at launch: fingerprint or face (the system offers the passcode when they fail), and the way out to a full
 * sign-in. `kind` ('face' or 'fingerprint') names the button when it is known. `mark` is the app's own icon.
 */
export function LockScreen({ appName, onUnlock, onSignInInstead, failed = false, busy = false, kind = null, mark = null }) {
  const { t } = useStrings();
  return (
    <Screen testID="lock-screen">
      {mark}
      <EmptyState
        title={t('lock.title', { app: appName })}
        action={
          <>
            <Button testID="lock-unlock" label={kind ? t('lock.unlockWith', { method: methodLabel(t, kind) }) : t('lock.action')} onPress={onUnlock} busy={busy} />
            <Button testID="lock-sign-in" label={t('lock.signInInstead')} onPress={onSignInInstead} kind={failed ? 'secondary' : 'quiet'} />
          </>
        }
      >
        {failed ? t('lock.failed') : null}
      </EmptyState>
    </Screen>
  );
}

/**
 * What a failed call means to the person, as a string key: no connection, no access, gone, or anything else. The
 * error's own message is never shown: it may carry what the server said about someone else's record.
 */
export function errorKey(error) {
  if (error?.status === 0 || error?.code === 'network' || error?.code === 'offline') return 'error.network';
  if (error?.status === 403) return 'error.forbidden';
  if (error?.status === 404) return 'error.notFound';
  return 'error.body';
}
