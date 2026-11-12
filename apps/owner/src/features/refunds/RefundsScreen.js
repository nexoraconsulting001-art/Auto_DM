import React, { useState } from 'react';
import { useStrings } from '@bhava/app-core';
import { Choices, ListRow, Screen, Text } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { formatPaise, orderBadges } from '../orders/kit/rules.js';
import { Badges, Offline, PagedList, formatWhenAt, usePaged } from '../orders/kit/ui.js';

const SHOW = ['partially_refunded', 'refunded'];

/**
 * Refunds (PRD 9.8): the orders money went back on, by how much of it went back. A refund is made from its order, by
 * the owner, with the amount they type; this list opens the order.
 */
export default function RefundsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const openLink = useOpenLink();
  const [payment, setPayment] = useState('partially_refunded');
  const query = usePaged(['orders', 'refunded', payment], (page) => api.orders.list({ payment, ...page }));
  return (
    <Screen testID="screen-refunds" title={t('refunds.title')}>
      <Offline />
      <Text variant="small">{t('refunds.intro')}</Text>
      <Choices testID="refunds-show" label={t('orders.filterLabel')} value={payment} onChange={setPayment} options={SHOW.map((value) => ({ value, label: t(`orders.status.payment.${value}`) }))} />
      <PagedList
        testID="refunds-orders"
        query={query}
        emptyTitle={t('refunds.empty')}
        renderRow={(order) => (
          <ListRow
            testID={`refunds-order-${order.id}`}
            title={`${order.orderNumber} · ${order.customerName}`}
            subtitle={[t('refunds.refunded', { amount: formatPaise(order.refundedPaise ?? 0), total: formatPaise(order.paidPaise ?? order.totalPaise) }), formatWhenAt(order.updatedAt, locale)].join(' · ')}
            end={<Badges items={orderBadges(order).slice(0, 1)} />}
            onPress={() => openLink(`/orders/${order.id}`)}
          />
        )}
      />
    </Screen>
  );
}
