/**
 * The parts of an order below its next step: parcels, payments, refunds, invoices, the messages the customer was
 * sent, and the timeline. Each reads its own list, so one that fails says so in its own place and the rest still
 * show. Every amount here is the server's; the only one the app ever sends is a refund a person types, on its own
 * screen.
 */
import React, { useState } from 'react';
import { Linking, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { errorKey, useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Banner, Button, Card, ConfirmSheet, Divider, Field, ListRow, Section, Sheet, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { CANCELLABLE_SHIPMENTS, canBookCourier, formatPaise, isCheckout, parseWhole, refundable } from './kit/rules.js';
import { ActionMessages, Fact, Journey, NumberField, StatusBadge, formatWhenAt, useAction, useAllowed, useWritable } from './kit/ui.js';

const ORDERS = ['orders'];

/** A section's own failure, in words, never the server's message. */
function SectionError({ query, testID }) {
  const { t } = useStrings();
  if (!query.error || query.data) return null;
  return <Banner tone="warn" testID={testID}>{t(errorKey(query.error))}</Banner>;
}

/** Only an https or the app's own link is opened. */
const openSafe = (url) => {
  if (/^https:\/\//i.test(String(url ?? ''))) Linking.openURL(url).catch(() => {});
};

// ---- parcels ----

export function OrderShipments({ order }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const writable = useWritable();
  const openLink = useOpenLink();
  const shipments = useQuery({ queryKey: ['orders', order.id, 'shipments'], queryFn: () => api.shipments.forOrder(order.id), enabled: isCheckout(order) });
  const action = useAction([ORDERS]);
  const [booking, setBooking] = useState(false);
  const [size, setSize] = useState({ weightGrams: '', lengthCm: '', breadthCm: '', heightCm: '' });
  const [cancelling, setCancelling] = useState(null);
  if (!isCheckout(order)) return null;
  const list = shipments.data?.items ?? [];

  async function book() {
    const body = {};
    for (const [key, max] of [['weightGrams', 500000], ['lengthCm', 500], ['breadthCm', 500], ['heightCm', 500]]) {
      const n = parseWhole(size[key], { min: 1, max });
      if (n !== null) body[key] = n;
    }
    const done = await action.run('book', () => api.shipments.create(order.id, body), { done: 'orders.ship.booked' });
    if (done) setBooking(false);
  }

  async function label(shipment) {
    const file = await action.run(`label:${shipment.id}`, () => api.shipments.label(shipment.id));
    if (file?.url) openSafe(file.url);
  }

  return (
    <Section title={t('orders.ship.title')} testID="order-shipments">
      <SectionError query={shipments} testID="order-shipments-error" />
      <ActionMessages action={action} testID="order-shipments-action" />
      {list.length ? (
        <Card>
          {list.map((shipment, i) => (
            <View key={shipment.id} style={{ gap: 8 }}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`shipment-${shipment.id}`}
                title={shipment.courierName || t(`orders.ship.mode.${shipment.mode}`)}
                subtitle={[shipment.awb ? t('orders.ship.awb', { awb: shipment.awb }) : null, shipment.kind === 'reverse' ? t('orders.ship.reverse') : null, shipment.codPaise ? t('orders.ship.cod', { amount: formatPaise(shipment.codPaise) }) : null, formatWhenAt(shipment.createdAt, locale)].filter(Boolean).join(' · ')}
                end={<StatusBadge group="shipment" status={shipment.status} />}
                onPress={() => openLink(`/shipments/${shipment.id}`)}
              />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {shipment.trackingUrl ? <Button kind="quiet" testID={`shipment-${shipment.id}-track`} label={t('orders.ship.track')} onPress={() => openSafe(shipment.trackingUrl)} /> : null}
                {shipment.hasLabel ? <Button kind="quiet" testID={`shipment-${shipment.id}-label`} label={t('orders.ship.label')} disabled={!writable} busy={action.busy === `label:${shipment.id}`} onPress={() => { label(shipment); }} /> : null}
                {CANCELLABLE_SHIPMENTS.includes(shipment.status) ? <Button kind="quiet" testID={`shipment-${shipment.id}-cancel`} label={t('orders.ship.cancel')} disabled={!writable} onPress={() => setCancelling(shipment)} /> : null}
              </View>
            </View>
          ))}
        </Card>
      ) : shipments.data ? <Text variant="small">{t('orders.ship.none')}</Text> : null}
      {canBookCourier(order, list) && shipments.data ? <Button testID="order-book" kind="secondary" label={t('orders.ship.book')} disabled={!writable} onPress={() => setBooking(true)} /> : null}
      <Sheet testID="order-book-sheet" visible={booking} onClose={() => setBooking(false)} closeLabel={t('common.cancel')} dismissable={action.busy !== 'book'} title={t('orders.ship.book')}
        footer={<Button testID="order-book-confirm" label={t('orders.ship.bookNow')} onPress={() => { book(); }} busy={action.busy === 'book'} disabled={!writable} />}
      >
        <Text variant="small">{t('orders.ship.sizeIntro')}</Text>
        <NumberField testID="order-book-weight" label={t('orders.ship.weight')} value={size.weightGrams} onChangeText={(v) => setSize((s) => ({ ...s, weightGrams: v }))} />
        <NumberField testID="order-book-length" label={t('orders.ship.length')} value={size.lengthCm} onChangeText={(v) => setSize((s) => ({ ...s, lengthCm: v }))} />
        <NumberField testID="order-book-breadth" label={t('orders.ship.breadth')} value={size.breadthCm} onChangeText={(v) => setSize((s) => ({ ...s, breadthCm: v }))} />
        <NumberField testID="order-book-height" label={t('orders.ship.height')} value={size.heightCm} onChangeText={(v) => setSize((s) => ({ ...s, heightCm: v }))} />
        {action.problem ? <Banner tone="bad">{action.problem}</Banner> : null}
      </Sheet>
      <ConfirmSheet
        testID="shipment-cancel"
        visible={Boolean(cancelling)}
        title={t('orders.ship.cancelTitle')}
        confirmLabel={t('orders.ship.cancel')}
        cancelLabel={t('orders.keep')}
        busy={action.busy === 'cancelShipment'}
        disabled={!writable}
        onCancel={() => setCancelling(null)}
        onConfirm={async () => {
          await action.run('cancelShipment', () => api.shipments.cancel(cancelling.id), { done: 'orders.ship.cancelled' });
          setCancelling(null);
        }}
      >
        {t('orders.ship.cancelBody')}
      </ConfirmSheet>
    </Section>
  );
}

// ---- payments ----

export function OrderPayments({ order }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const payments = useQuery({ queryKey: ['orders', order.id, 'payments'], queryFn: () => api.payments.forOrder(order.id), enabled: isCheckout(order) });
  if (!isCheckout(order)) return null;
  const list = payments.data?.items ?? [];
  return (
    <Section title={t('orders.pay.title')} testID="order-payments">
      <SectionError query={payments} testID="order-payments-error" />
      {list.length ? (
        <Card>
          {list.map((payment, i) => (
            <View key={payment.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`payment-${payment.id}`}
                title={`${t(`orders.pay.purpose.${payment.purpose}`)} · ${formatPaise(payment.amountPaise)}`}
                subtitle={[payment.method, payment.feePaise ? t('orders.pay.fee', { amount: formatPaise(payment.feePaise + payment.feeTaxPaise) }) : null, payment.refundedPaise ? t('orders.pay.refunded', { amount: formatPaise(payment.refundedPaise) }) : null, payment.transferStatus !== 'none' ? t(`orders.pay.transfer.${payment.transferStatus}`) : null, formatWhenAt(payment.capturedAt ?? payment.createdAt, locale)].filter(Boolean).join(' · ')}
                end={
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <StatusBadge group="attempt" status={payment.status} />
                    {payment.needsReview ? <StatusBadge group="hold" status="payment_mismatch" /> : null}
                  </View>
                }
              />
            </View>
          ))}
        </Card>
      ) : payments.data ? <Text variant="small">{t('orders.pay.none')}</Text> : null}
    </Section>
  );
}

// ---- refunds ----

export function OrderRefunds({ order }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const allowed = useAllowed();
  const openLink = useOpenLink();
  const refunds = useQuery({ queryKey: ['orders', order.id, 'refunds'], queryFn: () => api.refunds.forOrder(order.id), enabled: isCheckout(order) });
  if (!isCheckout(order)) return null;
  const list = refunds.data?.items ?? [];
  const most = refundable(order);
  return (
    <Section title={t('orders.refund.title')} testID="order-refunds">
      <SectionError query={refunds} testID="order-refunds-error" />
      {list.length ? (
        <Card>
          {list.map((refund, i) => (
            <View key={refund.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`refund-${refund.id}`}
                title={`${formatPaise(refund.amountPaise)} · ${t(`orders.refund.method.${refund.method}`)}`}
                subtitle={[refund.reason, refund.reference ? t('orders.refund.reference', { reference: refund.reference }) : null, formatWhenAt(refund.processedAt ?? refund.createdAt, locale)].filter(Boolean).join(' · ')}
                end={<StatusBadge group="refund" status={refund.status} />}
                onPress={() => openLink(`/refunds/${refund.id}`)}
              />
            </View>
          ))}
        </Card>
      ) : refunds.data ? <Text variant="small">{t('orders.refund.none')}</Text> : null}
      {most > 0 && allowed(OWNER_ONLY) ? (
        <Button testID="order-refund" kind="secondary" label={t('orders.refund.start', { amount: formatPaise(most) })} onPress={() => openLink(`/orders/${order.id}/refund`)} />
      ) : null}
      {most > 0 && !allowed(OWNER_ONLY) ? <Text variant="small">{t('orders.refund.ownerOnly')}</Text> : null}
    </Section>
  );
}

// ---- invoices ----

export function OrderInvoices({ order }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const openLink = useOpenLink();
  const invoices = useQuery({ queryKey: ['orders', order.id, 'invoices'], queryFn: () => api.invoices.list({ orderId: order.id }), enabled: isCheckout(order) });
  if (!isCheckout(order)) return null;
  const list = invoices.data?.items ?? [];
  return (
    <Section title={t('orders.invoice.title')} testID="order-invoices">
      <SectionError query={invoices} testID="order-invoices-error" />
      {list.length ? (
        <Card>
          {list.map((invoice, i) => (
            <View key={invoice.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow testID={`invoice-${invoice.id}`} title={`${t(`orders.invoice.kind.${invoice.docType}`)} ${invoice.number}`} subtitle={`${formatPaise(invoice.totalPaise)} · ${formatWhenAt(invoice.issuedAt, locale)}`} onPress={() => openLink(`/invoices/${invoice.id}`)} />
            </View>
          ))}
        </Card>
      ) : invoices.data ? <Text variant="small">{t('orders.invoice.none')}</Text> : null}
    </Section>
  );
}

// ---- messages to the customer ----

export function OrderAlerts({ order }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const writable = useWritable();
  const alerts = useQuery({ queryKey: ['orders', order.id, 'alerts'], queryFn: () => api.orderAlerts.list({ orderId: order.id, limit: 25 }), enabled: isCheckout(order) });
  const action = useAction([ORDERS]);
  if (!isCheckout(order)) return null;
  const list = alerts.data?.items ?? [];
  return (
    <Section title={t('orders.alerts.title')} testID="order-alerts">
      <SectionError query={alerts} testID="order-alerts-error" />
      <ActionMessages action={action} testID="order-alerts-action" />
      {list.length ? (
        <Card>
          {list.map((alert, i) => (
            <View key={alert.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`alert-${alert.id}`}
                title={`${t(`orders.alerts.event.${alert.event}`)} · ${t(`orders.alerts.channel.${alert.channel}`)}`}
                subtitle={[alert.skipReason ? t(`orders.alerts.skip.${alert.skipReason}`) : null, formatWhenAt(alert.sentAt ?? alert.createdAt, locale)].filter(Boolean).join(' · ')}
                end={
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <StatusBadge group="alert" status={alert.status} />
                    {alert.status === 'failed' ? <Button kind="quiet" testID={`alert-${alert.id}-retry`} label={t('common.retry')} disabled={!writable} busy={action.busy === `retry:${alert.id}`} onPress={() => action.run(`retry:${alert.id}`, () => api.orderAlerts.retry(alert.id), { done: 'orders.alerts.retried' })} /> : null}
                  </View>
                }
              />
            </View>
          ))}
        </Card>
      ) : alerts.data ? <Text variant="small">{t('orders.alerts.none')}</Text> : null}
    </Section>
  );
}

// ---- the timeline ----

function stepOf(t, entry, locale) {
  const meta = `${entry.actor} · ${formatWhenAt(entry.at, locale)}`;
  const note = [entry.reason, entry.note].filter(Boolean).join(' · ');
  switch (entry.kind) {
    case 'created':
      return { key: entry.id, title: t('orders.timeline.created'), meta, note };
    case 'fulfilment':
      return { key: entry.id, title: t(`orders.status.fulfilment.${entry.to}`), meta, note };
    case 'payment':
      return { key: entry.id, title: t('orders.timeline.payment', { status: t(`orders.status.payment.${entry.to}`) }), meta, note };
    case 'hold':
      return { key: entry.id, title: entry.to ? t('orders.timeline.hold', { hold: t(`orders.status.hold.${entry.to}`) }) : t('orders.timeline.released'), meta, note };
    default:
      return { key: entry.id, title: t('orders.timeline.note'), meta, note };
  }
}

export function OrderTimeline({ order }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const writable = useWritable();
  const timeline = useQuery({ queryKey: ['orders', order.id, 'timeline'], queryFn: () => api.orders.timeline(order.id) });
  const action = useAction([ORDERS]);
  const [note, setNote] = useState('');
  const items = [...(timeline.data?.items ?? [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const steps = items.map((entry, i) => ({ ...stepOf(t, entry, locale), state: i === items.length - 1 ? 'now' : 'done' }));

  async function add() {
    const text = note.trim();
    if (!text) return;
    const done = await action.run('note', () => api.orders.addNote(order.id, { note: text.slice(0, 1000) }), { done: 'orders.timeline.noted' });
    if (done) setNote('');
  }

  return (
    <Section title={t('orders.timeline.title')} testID="order-timeline">
      <SectionError query={timeline} testID="order-timeline-error" />
      {steps.length ? <Card><Journey steps={steps} testID="order-journey" /></Card> : null}
      <Field testID="order-note" label={t('orders.timeline.addNote')} value={note} onChangeText={setNote} maxLength={1000} multiline />
      <ActionMessages action={action} testID="order-note-action" />
      <Button testID="order-note-save" kind="secondary" label={t('orders.timeline.save')} disabled={!writable || !note.trim()} busy={action.busy === 'note'} onPress={() => { add(); }} />
    </Section>
  );
}

// ---- the money, as the server worked it out ----

export function OrderMoney({ order }) {
  const { t } = useStrings();
  const theme = useTheme();
  const checkout = isCheckout(order);
  const rows = [
    [t('orders.money.subtotal'), formatPaise(order.subtotalPaise)],
    checkout && order.discountPaise > 0 && [order.couponCode ? t('orders.money.coupon', { code: order.couponCode }) : t('orders.money.discount'), `−${formatPaise(order.discountPaise)}`],
    checkout && order.loyaltyPaise > 0 && [t('orders.money.points'), `−${formatPaise(order.loyaltyPaise)}`],
    [t('orders.money.delivery'), order.shippingPaise ? formatPaise(order.shippingPaise) : t('orders.money.free')],
    checkout && order.codFeePaise > 0 && [t('orders.money.codFee'), formatPaise(order.codFeePaise)],
    [t('orders.money.total'), formatPaise(order.totalPaise), true],
    checkout && order.taxPaise > 0 && [t('orders.money.gst'), formatPaise(order.taxPaise)],
    checkout && order.paymentMode === 'part_advance' && [t('orders.money.advance'), formatPaise(order.advancePaise)],
    checkout && ['part_advance', 'cod'].includes(order.paymentMode) && [t('orders.money.atDoor'), formatPaise(order.balancePaise)],
    checkout && [t('orders.money.paid'), formatPaise(order.paidPaise)],
    checkout && order.refundedPaise > 0 && [t('orders.money.refunded'), formatPaise(order.refundedPaise)],
  ].filter(Boolean);
  return (
    <Card testID="order-items">
      {(order.items ?? []).map((item) => (
        <ListRow
          key={item.id}
          testID={`order-item-${item.id}`}
          title={item.name}
          subtitle={[item.option, item.sku ? t('orders.money.sku', { sku: item.sku }) : null, `${formatPaise(item.pricePaise)} × ${item.qty}`].filter(Boolean).join(' · ')}
          end={<Text variant="body">{formatPaise(item.pricePaise * item.qty)}</Text>}
        />
      ))}
      {(order.items ?? []).length ? <Divider /> : null}
      <View style={{ gap: theme.space[1] }}>
        {rows.map(([label, value, strong]) => <Fact key={label} label={label} value={value} strong={Boolean(strong)} />)}
      </View>
    </Card>
  );
}
