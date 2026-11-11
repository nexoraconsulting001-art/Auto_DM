/**
 * Bhava for Business. The shell decides what is on screen from the session alone:
 *
 *   the API says this build is too old   Update required
 *   starting                             a spinner
 *   locked                               fingerprint, face or passcode, then the stored session resumes
 *   signed out                           sign-in
 *   signed in                            the navigation, built from the feature registry
 *
 * Features never touch this file: they register in src/features.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { LockScreen, SESSION_STATUS, StringsProvider, UpdateRequiredScreen, registerForPush, unregisterFromPush } from '@bhava/app-core';
import { sellerTheme } from '@bhava/theme';
import { Loading, ThemeProvider } from '@bhava/ui';
import { ServicesProvider, createServices, useServices, useSession } from './services.js';
import { APP_NAME } from './strings.js';
import { Navigation } from './shell/Navigation.js';
import { SignInScreen } from './shell/SignInScreen.js';

function Locked() {
  const { session, lock, store, strings } = useServices();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const unlock = useCallback(async () => {
    setBusy(true);
    const result = await lock.unlock(strings.t('lock.prompt', { app: APP_NAME }));
    if (result.ok) await session.resume().catch(() => setFailed(true));
    else if (result.reason !== 'cancelled') setFailed(true);
    setBusy(false);
  }, [lock, session, strings]);

  useEffect(() => {
    unlock();
  }, [unlock]);

  // The other way in is a full sign-in: the stored session is dropped first, so the lock is never simply skipped.
  const signInInstead = useCallback(async () => {
    await store.clearSession();
    await session.start();
  }, [store, session]);

  return <LockScreen appName={APP_NAME} onUnlock={unlock} onSignInInstead={signInInstead} failed={failed} busy={busy} />;
}

function Shell({ notifications }) {
  const { session, store, config } = useServices();
  const state = useSession();

  useEffect(() => {
    session?.start().catch(() => {});
  }, [session]);

  // A device revoked elsewhere is signed out on its next call; coming back to the app makes that call (P-08).
  useEffect(() => {
    if (!session) return undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && session.getState().status === SESSION_STATUS.signedIn) session.refreshUser().catch(() => {});
    });
    return () => subscription.remove();
  }, [session]);

  const signedIn = state?.status === SESSION_STATUS.signedIn;
  useEffect(() => {
    if (signedIn) registerForPush({ api: session.api, store, app: config.app, ...(notifications ? { notifications } : {}) }).catch(() => {});
  }, [signedIn, session, store, config, notifications]);

  if (state.updateRequired) return <UpdateRequiredScreen appName={APP_NAME} storeUrl={state.updateRequired.storeUrl} />;
  // Between two businesses nobody is known for a moment: nothing of either is drawn.
  if (state.status === SESSION_STATUS.loading || (signedIn && !state.user)) return <Loading testID="starting" label={APP_NAME} />;
  if (state.status === SESSION_STATUS.locked) return <Locked />;
  if (state.status === SESSION_STATUS.signedOut) return <SignInScreen />;
  return <Navigation notifications={notifications} />;
}

/** Signs out everywhere it matters: the push token first (while the session still works), then the session. */
export async function signOut({ session, store }) {
  await unregisterFromPush({ api: session.api, store });
  await session.signOut();
}

/** `services` and `notifications` are for tests; the app builds its own. */
export default function App({ services: given, notifications }) {
  const services = useMemo(() => given ?? createServices(defaults()), [given]);
  // A build with no API address has no session to follow: it shows why, and nothing else.
  const body = services.session ? <Shell notifications={notifications} /> : <SignInScreen />;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider theme={sellerTheme}>
          <StringsProvider strings={services.strings}>
            <ServicesProvider value={services}>
              {services.cache ? (
                <PersistQueryClientProvider client={services.queryClient} persistOptions={services.cache.persistOptions}>{body}</PersistQueryClientProvider>
              ) : (
                <QueryClientProvider client={services.queryClient}>{body}</QueryClientProvider>
              )}
            </ServicesProvider>
          </StringsProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** What only a real device has: its name, its language and the file the offline cache is kept in. */
function defaults() {
  const Device = require('expo-device');
  const { getLocales } = require('expo-localization');
  const { default: Storage } = require('expo-sqlite/kv-store');
  return { deviceName: Device.deviceName ?? Device.modelName ?? '', locale: getLocales()[0]?.languageTag ?? 'en', storage: Storage };
}
