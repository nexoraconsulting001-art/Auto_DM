/** Past orders, newest first, for a signed-in shopper. A guest sees the order they just placed on its confirmation, and signs in for the rest. */
import React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise, safeUrl } from '@bhava/store-client';
import { Badge, Button, EmptyState, ListRow, LoadingRows, Screen, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { Photo } from '../../shell/parts.js';
import { BUY, NeedSignIn, Problem, useBuy, useSessionState } from '../cart/ui.js';
import { paymentWords } from '../checkout/placing.js';

export default function OrdersScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const { config } = useServices();
  const { buy } = useBuy();
  const signedIn = useSessionState().status === 'signedIn';
  const query = useInfiniteQuery({
    queryKey: [BUY, 'orders'],
    enabled: signedIn,
    meta: { offline: false },
    networkMode: 'online',
    retry: false,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => buy.call('appOrders', { query: { cursor: pageParam, limit: 20 } }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (!signedIn) {
    return (
      <Screen testID="screen-orders" title={t('orders.title')}>
        <NeedSignIn go={(name) => navigation.navigate(name)} reason={t('orders.signInBody')} />
      </Screen>
    );
  }
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Screen testID="screen-orders" title={t('orders.title')}>
      {query.isError && !items.length ? <Problem error={query.error} onRetry={() => query.refetch()} /> : null}
      {query.isPending ? <LoadingRows rows={3} label={t('home.common.loading')} testID="orders-loading" /> : null}
      {query.data && !items.length ? <EmptyState testID="orders-empty" title={t('orders.emptyTitle')} action={<Button label={t('orders.keepShopping')} onPress={() => navigation.navigate('catalog.index')} />}>{t('orders.emptyBody')}</EmptyState> : null}
      {items.map((order) => (
        <ListRow
          key={order.orderNumber}
          testID={`order-${order.orderNumber}`}
          title={order.orderNumber}
          subtitle={`${new Date(order.placedAt).toLocaleDateString()} · ${t('orders.items', { count: order.itemCount })} · ${formatPaise(order.totalPaise)}`}
          start={<View style={{ width: 56 }}><Photo uri={safeUrl(config.origin, order.image)} name={order.orderNumber} /></View>}
          end={<Badge tone={paymentWords(order.paymentStatus) === 'paid' ? 'good' : 'neutral'} label={t(`orders.fulfilment.${order.fulfilmentStatus}`)} />}
          onPress={() => navigation.navigate('orders.order', { orderNumber: order.orderNumber })}
        />
      ))}
      {query.hasNextPage ? <Button testID="orders-more" kind="secondary" label={t('orders.more')} busy={query.isFetchingNextPage} onPress={() => query.fetchNextPage()} /> : null}
      <View style={{ height: theme.space[4] }} />
    </Screen>
  );
}
