/**
 * An order by its link or right after checkout: the confirmation. "Paid" is shown only when the server's own state says paid,
 * never because the payment screen came back. The bag is emptied here once the server says the order is placed. After the first
 * order, and only then, the notification explainer is offered.
 */
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise } from '@bhava/store-client';
import { Badge, Banner, Button, Card, LoadingRows, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';
import { paymentWords } from '../checkout/placing.js';
import { NotificationExplainer } from '../notifications/Explainer.js';

export default function OrderStatusScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const params = useRoute().params ?? {};
  const token = String(params.token ?? '');
  // Only the order just placed empties the bag and offers notifications; an old order opened from a link does neither.
  const justPlaced = params.justPlaced === true;
  const { services, buy } = useBuy();
  const state = useSessionState();
  const query = useStoreQuery(['order-state', token], () => buy.state(token), {
    enabled: token !== '',
    refetchInterval: (q) => (['pay', 'pending'].includes(q.state.data?.next) ? 3000 : false),
  });
  const order = query.data;
  const words = order ? paymentWords(order.paymentStatus) : null;
  const placed = order?.next === 'done' && justPlaced;

  useEffect(() => {
    if (placed) {
      services.cart?.clear();
      services.checkout?.attempt.reset();
    }
  }, [placed, services]);
  const settled = order?.next === 'done';

  const title = !order ? t('orders.status.checking')
    : words === 'paid' ? t('orders.status.paid')
      : words === 'cod' ? t('orders.status.cod')
        : words === 'advance' ? t('orders.status.advance')
          : order.next === 'failed' ? t('orders.status.failed')
            : order.next === 'pending' ? t('orders.status.confirming')
              : t('orders.status.waiting');
  return (
    <Screen testID="screen-order-status" title={t('orders.confirmTitle')}>
      {query.isError && !order ? <Problem error={query.error} onRetry={() => query.refetch()} /> : null}
      {!order && !query.isError ? <LoadingRows rows={2} label={t('home.common.loading')} testID="status-loading" /> : null}
      {order ? (
        <Card testID="order-status">
          <View style={{ gap: theme.space[2] }}>
            <Text variant="page" testID="order-status-title">{title}</Text>
            <Text variant="body" testID="order-number">{t('orders.number', { number: order.orderNumber })}</Text>
            <Text variant="title" testID="order-total">{formatPaise(order.totalPaise)}</Text>
            <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
              <Badge testID="order-fulfilment" label={t(`orders.fulfilment.${order.fulfilmentStatus}`)} />
              <Badge testID="order-payment" tone={words === 'paid' ? 'good' : words === 'failed' ? 'bad' : 'warn'} label={t(`orders.payment.${words}`)} />
            </View>
          </View>
        </Card>
      ) : null}
      {order?.next === 'pending' ? <Banner testID="status-pending" tone="info">{t('orders.pendingNote')}</Banner> : null}
      {order?.next === 'pay' ? <Button testID="status-pay" label={t('orders.payNow')} onPress={() => navigation.replace('payment.index', { token })} /> : null}
      {settled || order?.next === 'pending' ? <Button testID="status-track" kind="secondary" label={t('orders.track')} onPress={() => navigation.navigate('tracking.index', { token })} /> : null}
      {order && state.status === 'signedIn' ? <Button testID="status-order" kind="secondary" label={t('orders.viewOrder')} onPress={() => navigation.navigate('orders.order', { orderNumber: order.orderNumber })} /> : null}
      <Button testID="status-shop" kind="quiet" label={t('orders.keepShopping')} onPress={() => navigation.navigate('catalog.index')} />
      <NotificationExplainer enabled={placed} orderToken={token} />
    </Screen>
  );
}
