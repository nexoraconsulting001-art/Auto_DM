import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Banner, Button, Card, Choices, ConfirmSheet, Field, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { SELLER_CANCEL_REASONS, actionBody, formatPaise, isCheckout, orderActions, orderBadges } from './kit/rules.js';
import { ActionMessages, Badges, Offline, RecordView, StatusBadge, formatWhenAt, useAction, useAllowed, useWritable } from './kit/ui.js';
import { OrderAlerts, OrderInvoices, OrderMoney, OrderPayments, OrderRefunds, OrderShipments, OrderTimeline } from './OrderSections.js';

export const orderKey = (id) => ['orders', 'detail', id];

/**
 * One order (PRD 9.9, 10.4): what needs attention, the next step, the lines and money, the customer, parcels,
 * payments, refunds, invoices, messages and the timeline. The moves offered are exactly the ones the server says are
 * next. A move the state machine refuses shows the server's reason, and the order is read again so the screen shows
 * where it really is. Offline it opens on what was saved, with every change disabled.
 */
export default function OrderScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const { t } = useStrings();
  const order = useQuery({ queryKey: orderKey(id), queryFn: () => api.orders.get(id), enabled: Number.isInteger(id) && id > 0 });
  return (
    <Screen testID="screen-order">
      <Offline />
      <RecordView query={order} testID="order">
        {(data) => <Order order={data} />}
      </RecordView>
    </Screen>
  );
}

const HOLD_HELP = { payment_mismatch: 'orders.hold.help.payment_mismatch', paid_out_of_stock: 'orders.hold.help.paid_out_of_stock', cod_risk: 'orders.hold.help.cod_risk', review: 'orders.hold.help.review' };

function Order({ order }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const allowed = useAllowed();
  const writable = useWritable();
  const action = useAction([['orders']]);
  const [note, setNote] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('seller');
  const actions = orderActions(order);
  const moves = actions.filter((a) => a.kind !== 'cancel');
  const cancel = actions.find((a) => a.kind === 'cancel');

  function send(a, extra = {}) {
    const body = actionBody(a, { note, ...extra });
    const call = {
      advance: () => api.orders.advance(order.id, body),
      cancel: () => api.orders.cancel(order.id, body),
      release: () => api.orders.releaseHold(order.id, body),
      reinstate: () => api.orders.reinstate(order.id),
      setStatus: () => api.orders.setStatus(order.id, body),
    }[a.kind];
    return action.run(a.key, call, { done: `orders.done.${a.key}` }).then((done) => {
      if (done) setNote('');
      return done;
    });
  }

  return (
    <View style={{ gap: theme.space[4] }}>
      <View style={{ gap: theme.space[2] }}>
        <Text variant="page" testID="order-number">{order.orderNumber}</Text>
        <Badges items={orderBadges(order)} testID="order-badges" />
        <Text variant="meta">
          {[t('orders.placed', { when: formatWhenAt(order.createdAt, locale) }), isCheckout(order) && order.paymentMode ? t(`orders.mode.${order.paymentMode}`) : null, order.source === 'dm' ? t('orders.fromDm') : null].filter(Boolean).join(' · ')}
        </Text>
      </View>

      {order.holdReason ? <Banner tone={order.holdReason === 'cod_risk' || order.holdReason === 'review' ? 'warn' : 'bad'} testID="order-hold" title={t(`orders.status.hold.${order.holdReason}`)}>{t(HOLD_HELP[order.holdReason] ?? 'orders.hold.help.review')}</Banner> : null}
      {order.refundDuePaise > 0 ? (
        <Banner tone="warn" testID="order-refund-due" title={t('orders.refundDue', { amount: formatPaise(order.refundDuePaise) })}>
          {allowed(OWNER_ONLY) ? t('orders.refundDueBody') : t('orders.refund.ownerOnly')}
        </Banner>
      ) : null}
      {order.fulfilmentStatus === 'cancelled' && order.cancelReason ? <Text variant="small" testID="order-cancel-reason">{t(`orders.cancelReason.${order.cancelReason}`)}</Text> : null}

      {/* Outside the next step, so a refusal stays on screen when the order read again has no next step left. */}
      <ActionMessages action={action} testID="order-action" />
      {moves.length || cancel ? (
        <Section title={t('orders.next')} testID="order-next">
          {moves.length ? <Field testID="order-move-note" label={t('orders.moveNote')} value={note} onChangeText={setNote} maxLength={1000} /> : null}
          {moves.map((a, i) => (
            <Button
              key={a.key}
              testID={`order-action-${a.key}`}
              kind={i === 0 ? 'primary' : 'secondary'}
              label={t(`orders.action.${a.key}`)}
              accessibilityHint={t('orders.action.hint', { number: order.orderNumber })}
              disabled={!writable || Boolean(action.busy)}
              busy={action.busy === a.key}
              onPress={() => { send(a); }}
            />
          ))}
          {moves.some((a) => a.to === 'shipped') ? <Text variant="small">{t('orders.shipYourself')}</Text> : null}
          {cancel ? <Button testID="order-action-cancel" kind="danger" label={t('orders.action.cancel')} disabled={!writable || Boolean(action.busy)} onPress={() => setCancelling(true)} /> : null}
        </Section>
      ) : null}

      <OrderMoney order={order} />

      <Card testID="order-customer">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
          <Text variant="title" style={{ flex: 1 }}>{t('orders.customer')}</Text>
          {order.codRisk && order.codRisk !== 'none' ? <StatusBadge group="hold" status="cod_risk" /> : null}
        </View>
        <Text variant="body">{order.customerName}</Text>
        {order.address ? <Text variant="small">{[order.address, [order.city, order.state, order.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n')}</Text> : null}
        {order.phone ? <Text variant="small" testID="order-phone">{order.phone}</Text> : null}
        {order.email ? <Text variant="small">{order.email}</Text> : null}
        {order.codRisk && order.codRisk !== 'none' ? <Text variant="meta">{t('orders.codRiskNote')}</Text> : null}
      </Card>

      <OrderShipments order={order} />
      <OrderPayments order={order} />
      <OrderRefunds order={order} />
      <OrderInvoices order={order} />
      <OrderAlerts order={order} />
      <OrderTimeline order={order} />
      {order.reelId ? <Button kind="quiet" testID="order-reel" label={t('orders.fromReel')} onPress={() => openLink(`/reels/${order.reelId}`)} /> : null}

      <ConfirmSheet
        testID="order-cancel"
        visible={cancelling}
        title={t('orders.cancelTitle', { number: order.orderNumber })}
        confirmLabel={t('orders.action.cancel')}
        cancelLabel={t('orders.keep')}
        busy={action.busy === 'cancel'}
        disabled={!writable}
        onCancel={() => setCancelling(false)}
        onConfirm={async () => {
          await send(cancel, { reason });
          setCancelling(false);
        }}
      >
        <Text variant="small">{order.paidPaise > order.refundedPaise ? t('orders.cancelPaid', { amount: formatPaise(order.paidPaise - order.refundedPaise) }) : t('orders.cancelUnpaid')}</Text>
        <Choices testID="order-cancel-reason" label={t('orders.cancelReasonLabel')} value={reason} onChange={setReason} options={SELLER_CANCEL_REASONS.map((value) => ({ value, label: t(`orders.sellerReason.${value}`) }))} />
        <Field testID="order-cancel-note" label={t('orders.moveNote')} value={note} onChangeText={setNote} maxLength={1000} />
      </ConfirmSheet>
    </View>
  );
}
