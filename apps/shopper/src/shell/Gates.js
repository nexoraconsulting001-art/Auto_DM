/** The two things that sit above the tabs: the offline strip and the update-required screen. Both speak in the store's name. */
import React from 'react';
import { Linking, View } from 'react-native';
import { useStrings } from '@bhava/app-core/strings';
import { useOnline } from '@bhava/app-core/cache';
import { safeUrl } from '@bhava/store-client';
import { Button, EmptyState, Screen, Text, useTheme } from '@bhava/ui';
import { useBrandName } from './parts.js';

export function OfflineBanner() {
  const online = useOnline();
  const theme = useTheme();
  const { t } = useStrings();
  if (online) return null;
  return (
    <View testID="offline-banner" accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ backgroundColor: theme.color.accentTint, paddingVertical: theme.space[2], paddingHorizontal: theme.space.gutter }}>
      <Text variant="meta" style={{ color: theme.color.accentText }}>{t('home.common.offlineBanner')}</Text>
    </View>
  );
}

/** Shown instead of the tabs when the server says this version is too old. `storeUrl` is the store's link for the app. */
export function UpdateRequiredScreen({ storeUrl }) {
  const { t } = useStrings();
  const brand = useBrandName();
  const link = safeUrl('', storeUrl) || (/^(market|itms-apps):\/\/[^\s]+$/i.test(storeUrl ?? '') ? storeUrl : '');
  return (
    <Screen testID="update-required" scroll={false}>
      <EmptyState title={t('home.update.title', { brand })} action={link ? <Button testID="update-button" label={t('home.update.button')} onPress={() => Linking.openURL(link)} /> : null}>
        {t('home.update.body')}
      </EmptyState>
    </Screen>
  );
}
