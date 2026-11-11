import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Menu from 'lucide-react-native/icons/menu';
import {
  LockOffer, OfflineBanner, ReauthProvider, configurePush, createLinkRouter, useOnline, useStrings, watchConnection, watchLinks, watchPushTaps, watchPushToken,
} from '@bhava/app-core';
import { Card, ListRow, Loading, Screen, useTheme } from '@bhava/ui';
import { features } from '../features/index.js';
import { useServices, useSession } from '../services.js';
import { APP_NAME } from '../strings.js';
import { ShellContext } from './context.js';
import { startHeartbeat } from './heartbeat.js';
import { useStoredLocale } from './locale.js';
import { MORE, SWITCHER, TABS, buildNavigation, linkTarget, screenName } from './menu.js';
import { BusinessBadge, Switcher } from './Switcher.js';
import { TopBar } from './TopBar.js';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
export const navigationRef = createNavigationContainerRef();
/** What the navigators below draw: worked out once in Navigation, and read here so it stays current. */
const MenuContext = createContext(null);

/** One link router per session, kept across the remount a switch of business causes, so a tap is never opened twice. */
const routers = new WeakMap();
export function routerFor(session) {
  if (!routers.has(session)) routers.set(session, createLinkRouter({ session }));
  return routers.get(session);
}

/** Everything the person may open that is not in the tab bar. */
function MoreScreen({ navigation }) {
  const { t } = useStrings();
  const { moreEntries } = useContext(MenuContext);
  const { offline } = useSession();
  const online = useOnline();
  return (
    <Screen testID="more" title={t('more.title')}>
      <OfflineBanner offline={offline || !online} />
      <Card>
        {moreEntries.map((entry) => (
          <ListRow key={entry.name} testID={`more-${entry.feature}`} title={t(entry.label)} onPress={() => navigation.navigate(entry.name)} />
        ))}
      </Card>
    </Screen>
  );
}

function SwitcherScreen({ navigation }) {
  return <Switcher onDone={() => navigation.goBack()} />;
}

function Tabs() {
  const { tabs, moreEntries, topBar } = useContext(MenuContext);
  const { t } = useStrings();
  const theme = useTheme();
  return (
    <Tab.Navigator
      screenOptions={{
        header: topBar,
        tabBarActiveTintColor: theme.color.primary,
        tabBarInactiveTintColor: theme.color.ink3,
        tabBarStyle: { backgroundColor: theme.color.surface, borderTopColor: theme.color.line },
        tabBarLabelStyle: { fontFamily: theme.font.bodyMedium, fontSize: theme.text.caption },
      }}
    >
      {tabs.map((feature) => {
        const Icon = feature.nav.icon;
        return (
          <Tab.Screen
            key={feature.name}
            name={screenName(feature, feature.screens[0])}
            component={feature.screens[0].component}
            options={{ title: t(feature.nav.label), tabBarButtonTestID: `tab-${feature.name}`, tabBarIcon: Icon ? ({ color, size }) => <Icon color={color} size={size} /> : undefined }}
          />
        );
      })}
      {moreEntries.length > 0 ? (
        <Tab.Screen name={MORE} component={MoreScreen} options={{ title: t('tabs.more'), tabBarButtonTestID: 'tab-more', tabBarIcon: ({ color, size }) => <Menu color={color} size={size} /> }} />
      ) : null}
    </Tab.Navigator>
  );
}

/** The saved rows of the business in use, back in the query cache before its first screen draws (offline, P-19). */
function useRestored(cache, queryClient, tenantId) {
  const [restoredFor, setRestoredFor] = useState(cache ? null : tenantId);
  useEffect(() => {
    if (!cache) {
      setRestoredFor(tenantId);
      return undefined;
    }
    let live = true;
    cache.restoreInto(queryClient).catch(() => 0).finally(() => {
      if (live) setRestoredFor(tenantId);
    });
    return () => {
      live = false;
    };
  }, [cache, queryClient, tenantId]);
  return restoredFor === tenantId;
}

/**
 * The signed-in app: a tab bar of the four primary features and More, over a stack that holds every other screen.
 * All of it comes from the feature registry and what this person may open here: their role and permissions, the
 * plan's entitlements once the session knows them, and whether the account is a seller's or a creator's. Nothing here
 * names a feature.
 *
 * While it is open it also: opens what a tapped push or a link points at (switching business first, P-13); asks the
 * server every half minute whether the session still stands (P-08); follows the connection, so lists say they are
 * offline and changes are disabled (P-19); offers fingerprint or face unlock once after a sign-in (F-110); and holds
 * the fresh check sensitive changes need (P-17).
 *
 * `list`, `notifications`, `network`, `linking` and `appState` are for tests.
 */
export function Navigation({ list = features, notifications, network, linking = Linking, appState = AppState }) {
  const services = useServices();
  const { session, store, lock, queryClient, cache, config, strings } = services;
  const state = useSession();
  const { t } = useStrings();
  const theme = useTheme();
  const { user, business, tenantId } = state;
  const entitlements = state.entitlements ?? null;
  const accountType = business?.accountType ?? null;
  const nav = useMemo(() => buildNavigation(list, { user, entitlements, accountType }), [list, user, entitlements, accountType]);
  const moreEntries = useMemo(() => nav.more.map((feature) => ({ feature: feature.name, name: screenName(feature, feature.screens[0]), label: feature.nav.label })), [nav]);
  const restored = useRestored(cache, queryClient, tenantId);
  useStoredLocale(store, strings);
  const router = routerFor(session);

  // This business's navigation opens paths through the router, by what this person may open now.
  const navRef = useRef(nav);
  navRef.current = nav;
  const navigateTo = useCallback((path) => {
    const target = linkTarget(path, navRef.current);
    if (target && navigationRef.isReady()) navigationRef.navigate(...target);
  }, []);
  const detach = useRef(null);
  const onReady = useCallback(() => {
    detach.current?.();
    detach.current = router.attach(navigateTo, tenantId);
  }, [router, navigateTo, tenantId]);
  useEffect(() => () => detach.current?.(), [tenantId]);

  const native = notifications ? { notifications } : {};
  useEffect(() => watchPushTaps({ session, router, ...native }), [session, router, notifications]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => watchLinks({ linking, router }), [linking, router]);
  useEffect(() => watchPushToken({ api: session.api, store, app: config.app, ...native }), [session, store, config, notifications]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    configurePush({ ...native, channelName: t('push.channel') });
  }, [notifications, t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => watchConnection(network ?? require('expo-network')), [network]);
  useEffect(() => startHeartbeat({ check: session.check, appState }), [session, appState]);

  const header = useMemo(
    () => ({
      headerStyle: { backgroundColor: theme.color.ground },
      headerTintColor: theme.color.ink,
      headerTitleStyle: { fontFamily: theme.font.bodySemiBold, fontSize: theme.text.title },
      headerShadowVisible: false,
    }),
    [theme],
  );
  // Screens off the tab bar show the workspace in their header; the tabs have the whole top bar.
  const workspace = useMemo(
    () =>
      function Workspace() {
        return <BusinessBadge business={business} size={32} />;
      },
    [business],
  );
  const topBar = useCallback(() => <TopBar onSwitch={() => navigationRef.navigate(SWITCHER)} onNotifications={() => navigateTo('/notifications')} />, [navigateTo]);

  const menu = useMemo(() => ({ tabs: nav.tabs, moreEntries, topBar }), [nav, moreEntries, topBar]);
  const shell = useMemo(() => ({ openLink: (path) => router.open({ path }), nav }), [router, nav]);

  // Between two businesses nobody is known for a moment: nothing of either is drawn (P-10).
  if (!user || !business) return <Loading testID="switching" label={APP_NAME} />;
  if (!restored) return <Loading testID="restoring" label={APP_NAME} />;
  return (
    <ShellContext.Provider value={shell}>
      <MenuContext.Provider value={menu}>
        <ReauthProvider session={session} store={store} lock={lock} appName={APP_NAME}>
          {/* Keyed by business: switching rebuilds every screen, so no row of the old one is left on screen (P-10). */}
          <NavigationContainer ref={navigationRef} key={`business-${tenantId}`} onReady={onReady}>
            <Stack.Navigator screenOptions={{ ...header, headerRight: workspace }}>
              <Stack.Screen name={TABS} component={Tabs} options={{ headerShown: false }} />
              {nav.screens.filter((screen) => !screen.inTabs).map((screen) => (
                <Stack.Screen key={screen.name} name={screen.name} component={screen.component} options={{ title: t(screen.title) }} />
              ))}
              <Stack.Screen name={SWITCHER} component={SwitcherScreen} options={{ title: t('switcher.title'), presentation: 'modal' }} />
            </Stack.Navigator>
          </NavigationContainer>
          <LockOffer lock={lock} api={session.api} store={store} appName={APP_NAME} />
        </ReauthProvider>
      </MenuContext.Provider>
    </ShellContext.Provider>
  );
}
