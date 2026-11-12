/**
 * The navigator, built from the feature registry: one tab per feature with `nav`, and every other screen on a stack above
 * the tabs. Colours and fonts come from the theme, which comes from the brand; nothing here is written out.
 */
import React, { useMemo } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useStrings } from '@bhava/app-core/strings';
import { Loading, useTheme } from '@bhava/ui';
import { View } from 'react-native';
import { useServices } from '../services.js';
import { useUpdateRequired } from './gate.js';
import { OfflineBanner, UpdateRequiredScreen } from './Gates.js';
import { useOfflineCache } from './offline.js';
import { TABS, linkingOf, screenName, tabsOf } from './menu.js';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function Tabs({ features }) {
  const { t } = useStrings();
  const theme = useTheme();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.primary,
        tabBarInactiveTintColor: theme.color.ink3,
        tabBarStyle: { backgroundColor: theme.color.surface, borderTopColor: theme.color.line },
        tabBarLabelStyle: { fontFamily: theme.font.bodyMedium },
      }}
    >
      {tabsOf(features).map((feature) => {
        const screen = feature.screens[0];
        const Icon = feature.nav.icon;
        return (
          <Tab.Screen
            key={feature.name}
            name={screenName(feature, screen)}
            component={screen.component}
            options={{
              title: t(feature.nav.label),
              tabBarButtonTestID: `tab-${feature.name}`,
              tabBarAccessibilityLabel: t(feature.nav.label),
              tabBarIcon: ({ color, size }) => <Icon color={color} size={size} />,
            }}
          />
        );
      })}
    </Tab.Navigator>
  );
}

/** `brand` is the build's brand (its link scheme and hosts). `linking: false` in tests that render without links. */
export function Navigation({ features, brand, linking = true }) {
  const { t } = useStrings();
  const theme = useTheme();
  const services = useServices();
  const { ready } = useOfflineCache(services);
  const updateRequired = useUpdateRequired();
  const tabNames = useMemo(() => new Set(tabsOf(features).map((feature) => screenName(feature, feature.screens[0]))), [features]);
  const links = useMemo(() => (linking === false ? undefined : linking && typeof linking === 'object' ? linking : linkingOf(features, brand)), [features, brand, linking]);
  const TabsScreen = useMemo(() => () => <Tabs features={features} />, [features]);
  if (updateRequired) return <UpdateRequiredScreen storeUrl={updateRequired.storeUrl} />;
  if (!ready) return <Loading label={t('home.common.loading')} testID="starting" />;
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.ground }}>
      <OfflineBanner />
    <NavigationContainer linking={links}>
      <Stack.Navigator
        screenOptions={{
          headerTintColor: theme.color.ink,
          headerStyle: { backgroundColor: theme.color.ground },
          headerTitleStyle: { fontFamily: theme.font.display },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.color.ground },
        }}
      >
        <Stack.Screen name={TABS} component={TabsScreen} options={{ headerShown: false, title: t('shell.tabs') }} />
        {features.flatMap((feature) => feature.screens
          .filter((screen) => !tabNames.has(screenName(feature, screen)))
          .map((screen) => <Stack.Screen key={screenName(feature, screen)} name={screenName(feature, screen)} component={screen.component} options={{ title: t(screen.title) }} />))}
      </Stack.Navigator>
    </NavigationContainer>
    </View>
  );
}
