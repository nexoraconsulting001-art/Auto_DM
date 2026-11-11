import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { Pressable } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Menu from 'lucide-react-native/icons/menu';
import { OfflineBanner, useStrings, watchPushTaps } from '@bhava/app-core';
import { Card, ListRow, Screen, useTheme } from '@bhava/ui';
import { features } from '../features/index.js';
import { useServices, useSession } from '../services.js';
import { MORE, SWITCHER, TABS, buildNavigation, linkTarget, screenName } from './menu.js';
import { BusinessBadge, Switcher } from './Switcher.js';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();
export const navigationRef = createNavigationContainerRef();
/** What the navigators below draw: worked out once in Navigation, and read here so it stays current. */
const MenuContext = createContext(null);

/** Everything the person may open that is not in the tab bar. */
function MoreScreen({ navigation }) {
  const { t } = useStrings();
  const { moreEntries } = useContext(MenuContext);
  const { offline } = useSession();
  return (
    <Screen testID="more" title={t('more.title')}>
      <OfflineBanner offline={offline} />
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
  const { tabs, moreEntries, header, workspace } = useContext(MenuContext);
  const { t } = useStrings();
  const theme = useTheme();
  return (
    <Tab.Navigator
      screenOptions={{
        ...header,
        headerRight: workspace,
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

/**
 * The signed-in app: a tab bar of the four primary features and More, over a stack that holds every other screen.
 * All of it comes from the feature registry and what this person may open; nothing here names a feature.
 * `list` and `notifications` are for tests.
 */
export function Navigation({ list = features, notifications }) {
  const { session } = useServices();
  const state = useSession();
  const { t } = useStrings();
  const theme = useTheme();
  const { user, business, tenantId } = state;
  const entitlements = state.entitlements ?? null;
  const nav = useMemo(() => buildNavigation(list, { user, entitlements }), [list, user, entitlements]);
  const moreEntries = useMemo(() => nav.more.map((feature) => ({ feature: feature.name, name: screenName(feature, feature.screens[0]), label: feature.nav.label })), [nav]);

  // A tapped push switches business first, then opens the record (P-13).
  useEffect(() => {
    const open = (path) => {
      const target = linkTarget(path, nav);
      if (target && navigationRef.isReady()) navigationRef.navigate(...target);
    };
    return watchPushTaps({ session, open, ...(notifications ? { notifications } : {}) });
  }, [session, nav, notifications]);

  const header = useMemo(
    () => ({
      headerStyle: { backgroundColor: theme.color.ground },
      headerTintColor: theme.color.ink,
      headerTitleStyle: { fontFamily: theme.font.bodySemiBold, fontSize: theme.text.title },
      headerShadowVisible: false,
    }),
    [theme],
  );
  const workspace = useMemo(
    () =>
      function Workspace() {
        return (
          <Pressable testID="open-switcher" accessibilityRole="button" accessibilityLabel={t('switcher.title')} hitSlop={8} onPress={() => navigationRef.navigate(SWITCHER)} style={{ marginRight: theme.space[4] }}>
            <BusinessBadge business={business} size={32} />
          </Pressable>
        );
      },
    [business, t, theme],
  );

  // Keyed by business: switching rebuilds every screen, so no row of the old one is left on screen (P-10).
  const menu = useMemo(() => ({ tabs: nav.tabs, moreEntries, header, workspace }), [nav, moreEntries, header, workspace]);
  return (
    <MenuContext.Provider value={menu}>
    <NavigationContainer ref={navigationRef} key={`business-${tenantId}`}>
      <Stack.Navigator screenOptions={header}>
        <Stack.Screen name={TABS} component={Tabs} options={{ headerShown: false }} />
        {nav.screens.filter((screen) => !screen.inTabs).map((screen) => (
          <Stack.Screen key={screen.name} name={screen.name} component={screen.component} options={{ title: t(screen.title) }} />
        ))}
        <Stack.Screen name={SWITCHER} component={SwitcherScreen} options={{ title: t('switcher.title'), presentation: 'modal' }} />
      </Stack.Navigator>
    </NavigationContainer>
    </MenuContext.Provider>
  );
}
