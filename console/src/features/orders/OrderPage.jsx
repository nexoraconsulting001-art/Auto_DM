import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, FieldGroup, ListRow, Loadable, PageHeader, Panel, SelectField, Sheet, TextAreaField, TextField, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise, whatsAppLink } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { OrderInvoices } from '../invoices/OrderInvoices.jsx';
import { OrderPayments, OrderRefunds, RefundButton } from '../payments/OrderMoney.jsx';
import { OrderShipments } from '../shipping/OrderShipments.jsx';
import { OrderMessages } from '../store-settings/OrderMessages.jsx';
import { OrderStatusBadge } from './OrderStatusBadge.jsx';
import { OrderTimeline } from './OrderTimeline.jsx';
import { ORDER_STATUS } from './status.js';
import { HAND_MOVES, SELLER_CANCEL_REASONS } from './shared/contract.js';
import { CANCEL_REASON_LABELS, COD_RISK, HAND_MOVE_DONE, HAND_MOVE_LABELS, HOLD, PAYMENT_MODE_LABELS, SELLER_CANCEL_LABELS, statusOf } from './shared/labels.js';
import { canReinstate, orderBadges } from './shared/rules.js';
import { Badges, Facts, useAction } from './shared/ui.jsx';

/** A Phase 0 order still moves by its one status, as it always did. */
function StatusForm({ order }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ status: order.status, notes: order.notes });

  async function save(event) {
    event.preventDefault();
    const saved = await form.run(() => api.orders.setStatus(order.id, { status: form.values.status, notes: form.values.notes }));
    if (saved) {
      toast('Order updated.');
      await refresh();
    }
  }

  return (
    <Panel title="Update status">
      <form className="stack" onSubmit={save}>
        <FieldGroup>
          <SelectField label="Status" {...form.field('status')}>
            {Object.entries(ORDER_STATUS).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
          </SelectField>
          <TextAreaField label="Internal note" placeholder="e.g. UTR number, courier and tracking ID" {...form.field('notes')} />
        </FieldGroup>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Button type="submit" block loading={form.busy}>Save</Button>
        <p className="field-hint">Cancelling puts the items back in stock.</p>
      </form>
    </Panel>
  );
}

/** Lines and money, as the server worked them out. Nothing here is typed by the seller. */
function Items({ order }) {
  const checkout = order.flow === 'checkout';
  const partAdvance = order.paymentMode === 'part_advance';
  return (
    <Panel title="Items">
      <div className="row-list">
        {order.items.map((item) => (
          <ListRow
            key={item.id}
            as={item.productId ? Link : 'div'}
            {...(item.productId ? { to: `/catalog/${item.productId}` } : {})}
            leading={<Thumb src={item.image} />}
            title={item.name}
            meta={`${item.option ? `${item.option} · ` : ''}${item.sku ? `SKU ${item.sku} · ` : ''}${formatPaise(item.pricePaise)} × ${item.qty}`}
            trailing={<span className="row-money">{formatPaise(item.pricePaise * item.qty)}</span>}
          />
        ))}
      </div>
      <Facts
        className="totals"
        rows={[
          ['Subtotal', formatPaise(order.subtotalPaise)],
          checkout && order.discountPaise > 0 && [`Discount${order.couponCode ? ` (${order.couponCode})` : ''}`, `−${formatPaise(order.discountPaise)}`],
          checkout && order.loyaltyPaise > 0 && ['Points used', `−${formatPaise(order.loyaltyPaise)}`],
          ['Delivery', order.shippingPaise ? formatPaise(order.shippingPaise) : 'Free'],
          checkout && order.codFeePaise > 0 && ['Cash on delivery fee', formatPaise(order.codFeePaise)],
          ['Total', formatPaise(order.totalPaise), true],
          checkout && order.taxPaise > 0 && ['GST included', formatPaise(order.taxPaise)],
          checkout && partAdvance && ['Advance', formatPaise(order.advancePaise)],
          checkout && (partAdvance || order.paymentMode === 'cod') && ['Due at the door', formatPaise(order.balancePaise)],
          checkout && ['Paid so far', formatPaise(order.paidPaise)],
          checkout && order.refundedPaise > 0 && ['Refunded', formatPaise(order.refundedPaise)],
        ]}
      />
      <p className="field-hint">
        Placed {formatDateTime(order.createdAt)}
        {order.reelId && <> from <Link to={`/reels/${order.reelId}`}>this reel</Link></>}
        {order.source === 'dm' && ' via the DM link'}
        {checkout && order.paymentMode ? ` · ${PAYMENT_MODE_LABELS[order.paymentMode] ?? order.paymentMode}` : ''}.
      </p>
    </Panel>
  );
}

function Customer({ order }) {
  const { session } = useSession();
  const hello = `Hi ${order.customerName.split(' ')[0]}, this is ${session.business.name} about your order ${order.orderNumber}.`;
  const risk = order.codRisk ? COD_RISK[order.codRisk] : null;
  const digits = String(order.phone ?? '').replace(/\D/g, '');
  const tel = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  return (
    <Panel title="Customer" action={risk ? <Badge tone={risk.tone}>{risk.label}</Badge> : null}>
      <address className="address">
        {order.customerName}<br />
        {order.address}<br />
        {order.city}, {order.state} {order.pincode}
      </address>
      <p>
        <a href={`tel:${tel}`}>{digits.length === 10 ? `+91 ${order.phone}` : order.phone}</a>
        {order.email && <><br /><a href={`mailto:${order.email}`}>{order.email}</a></>}
      </p>
      {risk && <p className="field-hint">A label from the customer’s past deliveries. It never says where they shopped.</p>}
      <Button as="a" variant="soft" href={whatsAppLink(order.phone, hello)} target="_blank" rel="noopener">Message on WhatsApp</Button>
    </Panel>
  );
}

/** The moves a seller makes by hand: exactly the ones the server says are next, and cancelling before it ships. */
function NextStep({ order }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const action = useAction();
  const sheet = useRef(null);
  const [note, setNote] = useState('');
  const cancel = useForm({ reason: 'seller', note: '' });
  const moves = HAND_MOVES.filter((move) => (order.nextFulfilment ?? []).includes(move));
  if (!moves.length && !order.canCancel) return null;

  async function advance(to) {
    const done = await action.run(to, () => api.orders.advance(order.id, { to, ...(note.trim() ? { note: note.trim() } : {}) }), HAND_MOVE_DONE[to]);
    if (done) setNote('');
  }

  async function submitCancel(event) {
    event.preventDefault();
    let after = null;
    const done = await cancel.run(async () => {
      after = await api.orders.cancel(order.id, { reason: cancel.values.reason, ...(cancel.values.note.trim() ? { note: cancel.values.note.trim() } : {}) });
    });
    if (done) {
      sheet.current?.close();
      toast(after?.refundDuePaise ? `Order cancelled. Refund ${formatPaise(after.refundDuePaise)} to the customer.` : 'Order cancelled. The stock is back.');
      await refresh();
    }
  }

  return (
    <Panel title="Next step">
      <div className="order-actions">
        {moves.length > 0 && (
          <>
            <TextField label="Note for the timeline (optional)" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
            <div className="order-next">
              {moves.map((move) => <Button key={move} variant={move === moves[0] ? 'primary' : 'soft'} loading={action.busy === move} onClick={() => advance(move)}>{HAND_MOVE_LABELS[move]}</Button>)}
            </div>
            {moves.includes('shipped') && <p className="field-hint">Mark it shipped when you send it yourself. To use the courier, book it under Shipping.</p>}
          </>
        )}
        {action.problem && <Banner tone="bad">{action.problem}</Banner>}
        {order.canCancel && <Button variant="outline" onClick={() => sheet.current?.showModal()}>Cancel order</Button>}
      </div>
      <Sheet ref={sheet} title={`Cancel order ${order.orderNumber}?`}>
        <form className="stack" onSubmit={submitCancel}>
          <p className="sheet-text">The items go back into stock. {order.paidPaise > 0 ? `${formatPaise(order.paidPaise - order.refundedPaise)} was paid: you’ll be asked to refund it.` : 'Nothing was paid, so there is nothing to refund.'}</p>
          <FieldGroup>
            <SelectField label="Reason" {...cancel.field('reason')}>
              {SELLER_CANCEL_REASONS.map((reason) => <option key={reason} value={reason}>{SELLER_CANCEL_LABELS[reason]}</option>)}
            </SelectField>
            <TextField label="Note for the timeline (optional)" maxLength={1000} {...cancel.field('note')} />
          </FieldGroup>
          {cancel.message && <Banner tone="bad">{cancel.message}</Banner>}
          <div className="sheet-actions">
            <Button variant="outline" onClick={() => sheet.current?.close()}>Keep the order</Button>
            <Button type="submit" variant="danger" loading={cancel.busy}>Cancel order</Button>
          </div>
        </form>
      </Sheet>
    </Panel>
  );
}

const HOLD_HELP = {
  payment_mismatch: 'The amount paid didn’t match the order. Check the payment before you release it.',
  paid_out_of_stock: 'It was paid after its stock ran out. Add stock and release the hold, or cancel and refund it.',
  cod_risk: 'This customer often refuses cash on delivery parcels. Call them before you ship.',
  review: 'Check this order before it goes ahead.',
};

/** What needs the seller's attention before anything else: a hold, a refund owed, or a late payment to bring back. */
function Attention({ order }) {
  const allowed = useAllowed();
  const isOwner = allowed(OWNER_ONLY);
  const action = useAction();
  const lateButPaid = canReinstate(order);
  return (
    <>
      {order.holdReason && (
        <Banner tone={statusOf(HOLD, order.holdReason).tone === 'bad' ? 'bad' : 'warn'}>
          <strong>{statusOf(HOLD, order.holdReason).label}.</strong> {HOLD_HELP[order.holdReason] ?? ''}
          {' '}
          <Button variant="soft" loading={action.busy === 'release'} onClick={() => action.run('release', () => api.orders.releaseHold(order.id, {}), 'Hold released.')}>Release hold</Button>
        </Banner>
      )}
      {order.refundDuePaise > 0 && (
        <Banner tone="warn">
          <strong>Refund {formatPaise(order.refundDuePaise)}.</strong> This order was cancelled after it was paid. {isOwner ? '' : 'Only the owner can refund it.'}
          {' '}
          {isOwner && <RefundButton order={order} suggestedPaise={order.refundDuePaise} label={`Refund ${formatPaise(order.refundDuePaise)}`} variant="soft" />}
        </Banner>
      )}
      {lateButPaid && (
        <Banner tone="info">
          <strong>Paid after its hold ran out.</strong> Bring it back if you have the stock, or refund the payment.
          {' '}
          <Button variant="soft" loading={action.busy === 'reinstate'} onClick={() => action.run('reinstate', () => api.orders.reinstate(order.id), 'The order is back.')}>Bring the order back</Button>
        </Banner>
      )}
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
    </>
  );
}

function CheckoutOrder({ order }) {
  return (
    <>
      <BackLink to="/orders">Orders</BackLink>
      <PageHeader title={order.orderNumber} actions={<Badges items={orderBadges(order)} />} />
      <div className="stack">
        <Attention order={order} />
        {order.fulfilmentStatus === 'cancelled' && order.cancelReason && <p className="muted">{CANCEL_REASON_LABELS[order.cancelReason] ?? 'Cancelled'}{order.cancelledAt ? `, ${formatDateTime(order.cancelledAt)}` : ''}.</p>}
      </div>
      <div className="columns">
        <div className="stack">
          <NextStep order={order} />
          <Items order={order} />
          <OrderShipments order={order} />
          <OrderPayments order={order} />
          <OrderRefunds order={order} />
          <OrderInvoices order={order} />
        </div>
        <div className="stack">
          <Customer order={order} />
          <OrderMessages order={order} />
          <OrderTimeline orderId={order.id} />
        </div>
      </div>
    </>
  );
}

function ManualOrder({ order }) {
  return (
    <>
      <BackLink to="/orders">Orders</BackLink>
      <PageHeader title={order.orderNumber} actions={<OrderStatusBadge status={order.status} />} />
      <div className="columns">
        <Items order={order} />
        <div className="stack">
          <StatusForm key={`${order.id}-${order.updatedAt}`} order={order} />
          <Customer order={order} />
          <OrderTimeline orderId={order.id} />
        </div>
      </div>
    </>
  );
}

export default function OrderPage() {
  const { id } = useParams();
  const order = useQuery({ queryKey: ['orders', id], queryFn: () => api.orders.get(id) });
  return (
    <Loadable query={order} detail label="Loading this order" errorTitle="We couldn’t load this order">
      {(data) => (data.flow === 'checkout' ? <CheckoutOrder order={data} /> : <ManualOrder order={data} />)}
    </Loadable>
  );
}
