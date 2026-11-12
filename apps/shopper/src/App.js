/**
 * The shopper app's shell. It draws one brand's store: the brand, its colours and its address were written into the build
 * (src/brand.js), and the screens come from the feature registry. Browsing needs no sign-in, so there is no gate here: the
 * tabs open at once. Features never touch this file: they register in src/features.
 */
import React, { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { StringsProvider, createStrings } from '@bhava/app-core/strings';
import { fromBrandKit } from '@bhava/theme';
import { EmptyState, Screen, ThemeProvider } from '@bhava/ui';
import { ServicesProvider, createServices } from './services.js';
import { Navigation } from './shell/Navigation.js';
import { shellStrings } from './strings.js';

function start(given) {
  if (given) return { services: given };
  try {
    return { services: createServices({ locale: require('expo-localization').getLocales()[0]?.languageTag ?? 'en' }) };
  } catch {
    // A build made without a brand has nothing to show and nowhere to call: it says so, in neutral colours.
    return { services: null };
  }
}

/** `services` and `linking` are for tests; the app builds its own. */
export default function App({ services: given, linking }) {
  const { services } = useMemo(() => start(given), [given]);
  if (!services) {
    const strings = createStrings(shellStrings);
    return (
      <SafeAreaProvider>
        <ThemeProvider theme={fromBrandKit({})}>
          <StringsProvider strings={strings}>
            <Screen testID="no-brand">
              <EmptyState title={strings.t('shell.noBrand.title')}>{strings.t('shell.noBrand.body')}</EmptyState>
            </Screen>
          </StringsProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    );
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider theme={services.theme}>
          <StringsProvider strings={services.strings}>
            <ServicesProvider value={services}>
              <QueryClientProvider client={services.queryClient}>
                <Navigation features={services.features} brand={services.config.brand} linking={linking} />
              </QueryClientProvider>
            </ServicesProvider>
          </StringsProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
