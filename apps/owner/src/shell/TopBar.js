/**
 * The bar over every tab (OwnerApp and m-Home designs): the platform's own mark, the workspace in use (its badge,
 * its name and what the person is there) which opens the switcher, and the bell with the unread count. The app is
 * the platform's throughout; the business shows only as the workspace (P-67).
 */
import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import Bell from 'lucide-react-native/icons/bell';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import { useStrings } from '@bhava/app-core';
import { IconButton, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../services.js';
import { APP_NAME } from '../strings.js';
import { BusinessBadge } from './Switcher.js';

const mark = require('../../assets/icon.png');

/** The platform's mark: the app icon, small. Said once to a screen reader as the app's name. */
export function AppMark({ size = 32 }) {
  const theme = useTheme();
  return (
    <View testID="app-mark" accessible accessibilityRole="image" accessibilityLabel={APP_NAME} style={{ width: size, height: size, borderRadius: theme.radius.small, overflow: 'hidden' }}>
      <Image source={mark} style={{ width: size, height: size }} contentFit="cover" />
    </View>
  );
}

/** The unread count for the bell, kept in the query cache like any list (and dropped with it on a switch). */
export function useUnreadCount() {
  const { api } = useServices();
  const { tenantId } = useSession();
  const query = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.notifications.list({ unread: '1', limit: 1 }),
    enabled: Boolean(api && tenantId),
    refetchInterval: 60_000,
    select: (answer) => (Number.isInteger(answer?.unread) ? answer.unread : 0),
  });
  return query.data ?? 0;
}

export function TopBar({ onSwitch, onNotifications }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const { business, user } = useSession();
  const unread = useUnreadCount();
  const role = user?.role ? t(`role.${user.role}`) : '';
  const kind = business?.accountType ? t(`accountType.${business.accountType}`) : '';
  return (
    <View
      testID="top-bar"
      style={{
        paddingTop: insets.top + theme.space[2], paddingBottom: theme.space[2], paddingHorizontal: theme.space[4], gap: theme.space[3],
        flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.ground,
      }}
    >
      <AppMark />
      <Pressable
        testID="open-switcher"
        onPress={onSwitch}
        accessibilityRole="button"
        accessibilityLabel={t('workspace.switch', { business: business?.name ?? '' })}
        style={({ pressed }) => ({
          flex: 1, minWidth: 0, minHeight: theme.tap.min, flexDirection: 'row', alignItems: 'center', gap: theme.space[2], paddingHorizontal: theme.space[2],
          borderRadius: theme.radius.tile, borderWidth: 1, borderColor: theme.color.line, backgroundColor: theme.color.surface, opacity: pressed ? 0.8 : 1,
        })}
      >
        <BusinessBadge business={business} size={30} />
        <View style={{ flex: 1, minWidth: 0 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Text variant="small" numberOfLines={1} style={{ color: theme.color.ink, fontFamily: theme.font.bodySemiBold }}>{business?.name ?? ''}</Text>
          {role || kind ? <Text variant="caption" numberOfLines={1}>{[role, kind].filter(Boolean).join(' · ')}</Text> : null}
        </View>
        <ChevronDown color={theme.color.ink2} size={16} />
      </Pressable>
      <IconButton
        testID="open-notifications"
        label={unread > 0 ? t('workspace.notificationsUnread', { count: unread }) : t('workspace.notifications')}
        count={unread}
        icon={<Bell color={theme.color.ink} size={20} />}
        onPress={onNotifications}
      />
    </View>
  );
}
