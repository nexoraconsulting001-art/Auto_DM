import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { OWNER_APP_CALLBACK, OfflineBanner, formatDate, useStrings } from '@bhava/app-core';
import { MANAGERS, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, ConfirmSheet, Divider, ListRow, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { RecordState, Refusal, useWritable } from '../compliance/kit.js';
import { SCOPES } from '../compliance/notices.js';
import { RETURN_TO, connectionView, isMetaLogin, pageView } from './connection.js';

export const IG_KEY = ['connect', 'instagram'];
export const FB_KEY = ['connect', 'facebook'];

/**
 * Meta's own login, in the system browser (never a web view inside the app, so the app never sees a password): the
 * server makes the address, an auth session opens it (ASWebAuthenticationSession on iOS, Custom Tabs on Android, PRD
 * 10.4), and when the person comes back to the app the connection is read again. Meta returns the browser to the
 * business's own connect page, not to the app, so the read happens when the session closes or the app is active again.
 * `browser` is expo-web-browser; `appState` is react-native's AppState. Both are passed in by tests.
 */
export function useBrowserConnect(start, { browser, appState = AppState, keys }) {
  const queryClient = useQueryClient();
  const [away, setAway] = useState(false);
  const reread = () => Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  const rereadRef = useRef(reread);
  rereadRef.current = reread;
  useEffect(() => {
    if (!away) return undefined;
    const subscription = appState?.addEventListener?.('change', (next) => {
      if (next === 'active') {
        setAway(false);
        rereadRef.current();
      }
    });
    return () => subscription?.remove?.();
  }, [away, appState]);
  return useMutation({
    mutationFn: async () => {
      const { authorizeUrl } = await start({ returnTo: RETURN_TO });
      if (!isMetaLogin(authorizeUrl)) throw Object.assign(new Error('not a Meta login'), { status: 502 });
      setAway(true);
      const result = browser.openAuthSessionAsync ? await browser.openAuthSessionAsync(authorizeUrl, OWNER_APP_CALLBACK) : await browser.openBrowserAsync(authorizeUrl);
      return result?.type ?? 'opened';
    },
    // iOS hands back when the sheet closes; Android as soon as the tab opens, and AppState catches the return.
    onSettled: (type) => {
      if (type && type !== 'opened') {
        setAway(false);
        reread();
      }
    },
  });
}

function useDisconnect(remove, keys) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: remove, onSuccess: () => Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))) });
}

function Scopes({ connection }) {
  const { t } = useStrings();
  return (
    <Section title={t('connect.scopes.title')}>
      <Card>
        {SCOPES.map((scope, i) => {
          const granted = connection.scopes.includes(scope);
          return (
            <View key={scope}>
              {i > 0 ? <Divider /> : null}
              <ListRow testID={`scope-${scope}`} title={t(`connect.scope.${scope}`)} subtitle={t(`connect.scopeDetail.${scope}`)} end={<Badge label={t(granted ? 'connect.scopes.allowed' : 'connect.scopes.needed')} tone={granted ? 'good' : 'warn'} />} />
            </View>
          );
        })}
        <Text variant="meta">{t('connect.scopes.neverPosts')}</Text>
      </Card>
    </Section>
  );
}

function Instagram({ connection, canManage, writable, browser, appState }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  const view = connectionView(connection);
  const connect = useBrowserConnect((body) => api.instagram.connect(body), { browser, appState, keys: [IG_KEY, ['compliance']] });
  const disconnect = useDisconnect(() => api.instagram.disconnect(), [IG_KEY, ['compliance']]);
  return (
    <>
      <Card testID="connect-instagram">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
          <Text variant="title" style={{ flex: 1 }}>{t(view.title.key, view.title.values)}</Text>
          <Badge testID="connect-ig-badge" label={t(view.badge)} tone={view.tone} />
        </View>
        {view.connected && connection.tokenExpiresAt ? <Text variant="small">{t('connect.ig.renews', { date: formatDate(connection.tokenExpiresAt, { locale }) })}</Text> : null}
        {view.connected && !connection.webhooksSubscribed ? <Banner tone="warn">{t('connect.ig.noWebhooks')}</Banner> : null}
        {connection.status !== 'active' ? <Text variant="small">{t(`connect.ig.status.${connection.status}`)}</Text> : null}
        {canManage && view.action ? (
          <Button testID="connect-ig-start" label={t(view.action)} busy={connect.isPending} disabled={!writable} accessibilityHint={t('connect.browserHint')} onPress={() => connect.mutate()} />
        ) : null}
        {!canManage && view.action ? <Text variant="meta" testID="connect-ask-manager">{t('connect.askManager')}</Text> : null}
        {connect.isSuccess ? <Text variant="meta" testID="connect-ig-returned">{t('connect.returned')}</Text> : null}
        <Refusal error={connect.error ?? disconnect.error} testID="connect-ig-refusal" />
        <Text variant="meta">{t('connect.promise')}</Text>
      </Card>
      {connection.status !== 'not_connected' ? <Scopes connection={connection} /> : null}
      {canManage && view.connected ? <Button testID="connect-ig-disconnect" kind="danger" label={t('connect.ig.disconnect')} disabled={!writable} busy={disconnect.isPending} onPress={() => setAsking(true)} /> : null}
      <ConfirmSheet
        testID="connect-ig-disconnect-confirm"
        visible={asking}
        title={t('connect.ig.disconnectTitle')}
        confirmLabel={t('connect.ig.disconnect')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          disconnect.mutate();
        }}
        disabled={!writable}
      >
        {t('connect.ig.disconnectBody')}
      </ConfirmSheet>
    </>
  );
}

/** Nothing at all until Facebook Pages is switched on for the business (PRD 6.10); a server without it answers an error, which also means nothing. */
function Facebook({ canManage, writable, browser, appState, onPosts }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const [asking, setAsking] = useState(false);
  const page = useQuery({ queryKey: FB_KEY, queryFn: () => api.facebook.connection(), retry: false });
  const connect = useBrowserConnect((body) => api.facebook.connect(body), { browser, appState, keys: [FB_KEY, ['compliance']] });
  const disconnect = useDisconnect(() => api.facebook.disconnect(), [FB_KEY, ['compliance']]);
  if (!page.data?.enabled) return null;
  const view = pageView(page.data);
  return (
    <Section title={t('connect.fb.title')}>
      <Card testID="connect-facebook">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
          <Text variant="body" style={{ flex: 1 }}>{view.connected ? page.data.pageName : t('connect.fb.optional')}</Text>
          <Badge testID="connect-fb-badge" label={t(view.badge)} tone={view.tone} />
        </View>
        {canManage && view.action ? <Button testID="connect-fb-start" kind="secondary" label={t(view.action)} busy={connect.isPending} disabled={!writable} accessibilityHint={t('connect.browserHint')} onPress={() => connect.mutate()} /> : null}
        {view.connected ? <Button testID="connect-fb-posts" kind="secondary" label={t('connect.fb.posts')} onPress={onPosts} /> : null}
        {canManage && view.connected ? <Button testID="connect-fb-disconnect" kind="quiet" label={t('connect.fb.disconnect')} disabled={!writable} busy={disconnect.isPending} onPress={() => setAsking(true)} /> : null}
        <Refusal error={connect.error ?? disconnect.error} testID="connect-fb-refusal" />
      </Card>
      <ConfirmSheet
        testID="connect-fb-disconnect-confirm"
        visible={asking}
        title={t('connect.fb.disconnectTitle')}
        confirmLabel={t('connect.fb.disconnect')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          disconnect.mutate();
        }}
        disabled={!writable}
      >
        {t('connect.fb.disconnectBody')}
      </ConfirmSheet>
    </Section>
  );
}

/**
 * Connecting and reconnecting Instagram, and the optional Facebook Page (PRD 4.2, 6.10). Staff with the automations
 * permission see the state; the owner and managers connect, reconnect and disconnect, in the system browser on
 * Meta's own pages. The app never asks for an Instagram password.
 */
export default function ConnectScreen({ navigation, native = { browser: WebBrowser }, appState = AppState }) {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const writable = useWritable();
  const canManage = isAllowed(user, MANAGERS);
  const connection = useQuery({ queryKey: IG_KEY, queryFn: () => api.instagram.connection() });
  return (
    <Screen testID="screen-connect" title={t('connect.title')}>
      <OfflineBanner offline={!writable} />
      <RecordState query={connection} testID="connect">
        {(current) => <Instagram connection={current} canManage={canManage} writable={writable} browser={native.browser} appState={appState} />}
      </RecordState>
      <Facebook canManage={canManage} writable={writable} browser={native.browser} appState={appState} onPosts={() => navigation?.navigate('connect.facebook')} />
    </Screen>
  );
}
