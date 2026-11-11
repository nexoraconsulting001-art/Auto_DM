import React from 'react';
import { View } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import Bell from 'lucide-react-native/icons/bell';
import { OfflineBanner, errorKey, formatWhen, useOnline, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, Divider, EmptyState, ListRow, ListState, Screen, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';

export const LIST_KEY = ['notifications', 'list'];
const UNREAD_KEY = ['notifications', 'unread'];

/** Marks rows read in what is on screen and in the bell's count, without waiting for the server. */
function markLocally(queryClient, ids) {
  const now = new Date().toISOString();
  let marked = 0;
  queryClient.setQueryData(LIST_KEY, (old) => {
    if (!old) return old;
    const pages = old.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => {
        if (item.readAt || (ids !== 'all' && !ids.includes(item.id))) return item;
        marked++;
        return { ...item, readAt: now };
      }),
    }));
    // Every page carries the total unread count: it drops by what was just marked.
    return { ...old, pages: pages.map((page) => ({ ...page, unread: ids === 'all' ? 0 : Math.max(0, (page.unread ?? 0) - marked) })) };
  });
  queryClient.setQueryData(UNREAD_KEY, (old) => old && { ...old, unread: ids === 'all' ? 0 : Math.max(0, (old.unread ?? 0) - marked) });
}

/**
 * The in-app list (PRD 5.13): newest first, unread in bold, and a tap opens the record the notice is about, in this
 * business. Each row carries the platform's own bell, never a business's logo (P-67). Offline it shows what was saved
 * and leaves everything as it is: marking read needs the server.
 */
export default function NotificationsScreen() {
  const { api } = useServices();
  const { offline } = useSession();
  const online = useOnline() && !offline;
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const openLink = useOpenLink();
  const theme = useTheme();
  const { t, locale } = useStrings();

  const list = useInfiniteQuery({
    queryKey: LIST_KEY,
    queryFn: ({ pageParam }) => api.notifications.list({ limit: 30, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
  });
  const markRead = useMutation({
    mutationFn: (ids) => api.notifications.markRead(ids === 'all' ? { all: true } : { ids }),
    onMutate: (ids) => markLocally(queryClient, ids),
    onError: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const unread = list.data?.pages[0]?.unread ?? 0;

  function open(item) {
    if (!item.readAt && online) markRead.mutate([item.id]);
    if (item.link) openLink(item.link);
  }

  return (
    <Screen testID="screen-notifications" title={t('notifications.title')}>
      <OfflineBanner offline={!online} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space[2] }}>
        {unread > 0 ? <Badge testID="notifications-unread" label={t('notifications.unread', { count: unread })} tone="primary" /> : null}
        <View style={{ flex: 1 }} />
        <Button testID="notifications-mark-all" kind="quiet" label={t('notifications.markAll')} disabled={!online || unread === 0} onPress={() => markRead.mutate('all')} />
      </View>
      <ListState
        testID="notifications"
        loading={list.isPending}
        error={list.error}
        empty={items.length === 0}
        loadingLabel={t('common.loading')}
        errorTitle={t('error.title')}
        errorBody={list.error ? t(errorKey(list.error)) : ''}
        onRetry={() => list.refetch()}
        retryLabel={t('common.retry')}
        emptyView={<EmptyState testID="notifications-empty" title={t('notifications.empty')}>{t('notifications.emptyBody')}</EmptyState>}
      >
        <Card>
          {items.map((item, i) => (
            <View key={item.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`notification-${item.id}`}
                title={item.title}
                subtitle={`${item.body}${item.body ? ' · ' : ''}${formatWhen(t, item.createdAt, { locale })}`}
                emphasis={!item.readAt}
                accessibilityLabel={`${item.readAt ? item.title : t('notifications.unreadLabel', { title: item.title })}, ${item.body}`}
                start={<Bell color={item.readAt ? theme.color.ink3 : theme.color.primary} size={20} />}
                onPress={() => open(item)}
              />
            </View>
          ))}
        </Card>
        {list.hasNextPage ? <Button testID="notifications-more" kind="secondary" label={t('notifications.more')} busy={list.isFetchingNextPage} disabled={!online} onPress={() => list.fetchNextPage()} /> : null}
      </ListState>
      <Button testID="notifications-settings" kind="secondary" label={t('notifications.openSettings')} onPress={() => navigation.navigate('notifications.settings')} />
    </Screen>
  );
}
