import React from 'react';
import { View } from 'react-native';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, Divider, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { PagedState, formatDateTime, usePaged, useWritable } from '../compliance/kit.js';
import { describeResult, handleOf } from './results.js';

export const ACTIVITY_KEY = ['activity', 'list'];

/** One comment and what happened to it. The words are the commenter's and stay on this screen: nothing here is logged. */
export function ActivityRow({ row, compact = false }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const { label, tone } = describeResult(t, row.result);
  return (
    <View testID={`activity-${row.id}`} style={{ gap: theme.space[1], paddingVertical: theme.space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        <Text variant="title" numberOfLines={1} style={{ flex: 1 }}>{handleOf(t, row.username)}</Text>
        <Badge label={label} tone={tone} />
      </View>
      {row.text ? <Text variant="small" numberOfLines={compact ? 2 : 4}>{row.text}</Text> : null}
      {!compact && row.error ? <Text variant="meta" tone="bad">{row.error}</Text> : null}
      <Text variant="meta">{formatDateTime(row.createdAt, { locale })}</Text>
      {!compact && row.reelId && row.reelSlug ? (
        <Button testID={`activity-${row.id}-reel`} kind="quiet" label={row.reelHeadline || row.reelSlug} accessibilityHint={t('activity.openReel')} onPress={() => openLink(`/reels/${row.reelId}`)} />
      ) : null}
    </View>
  );
}

/** DM activity: every comment received and what happened to it, newest first, from the offline cache when there is no connection. */
export default function ActivityScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const activity = usePaged(ACTIVITY_KEY, (query) => api.activity.list(query), { limit: 30 }, { refetchInterval: 30_000 });
  return (
    <Screen testID="screen-activity" title={t('activity.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('activity.intro')}</Text>
      <Card>
        <PagedState query={activity} testID="activity" emptyTitle={t('activity.empty')} emptyBody={t('activity.emptyBody')}>
          {activity.items.map((row, i) => (
            <View key={row.id}>
              {i > 0 ? <Divider /> : null}
              <ActivityRow row={row} />
            </View>
          ))}
        </PagedState>
      </Card>
    </Screen>
  );
}
