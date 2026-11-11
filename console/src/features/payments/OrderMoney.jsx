import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OWNER_ONLY } from '@contracts/access.js';
import { Banner, Button, EmptyState, FieldGroup, Panel, SelectField, Sheet, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise, paiseToRupees, rupeesToPaise } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { useFeedback } from '../../components/feedback.jsx';
import { PAYMENT_ATTEMPT, PAYMENT_PURPOSE, REFUND, REVERSAL, TRANSFER, statusOf } from '../orders/shared/labels.js';
import { refundable } from '../orders/shared/rules.js';
import { Badges, RupeeField, StoreScreen, freshKey, useAction } from '../orders/shared/ui.jsx';

/**
 * An order's money (PRD 9.6 to 9.8): its payments at the gateway, its refunds, and the owner's refund. No route takes an order
 * amount; the refund's is the one amount a person types, and the server and the database both hold it inside what was paid.
 */
/** How the shopper paid, as the gateway names it, in the seller's words. */
const METHOD_LABELS = Object.freeze({ upi: 'UPI', card: 'card', netbanking: 'netbanking', wallet: 'wallet', emi: 'EMI', paylater: 'pay later', cod: 'cash' });

export const paymentsKey = (orderId) => ['payments', String(orderId)];
export const refundsKey = (orderId) => ['refunds', String(orderId)];

export function OrderPayments({ order }) {
  const payments = useQuery({ queryKey: paymentsKey(order.id), queryFn: () => api.payments.forOrder(order.id) });
  return (
    <Panel title="Payments">
      <StoreScreen query={payments} label="Loading the payments" errorTitle="We couldn’t load the payments">
        {({ items }) => (items.length ? (
          <div>
            {items.map((payment) => {
              const status = statusOf(PAYMENT_ATTEMPT, payment.status);
              const fee = payment.feePaise + payment.feeTaxPaise;
              return (
                <div key={payment.id} className="order-line">
                  <div className="order-line-head">
                    <span className="order-line-title">{PAYMENT_PURPOSE[payment.purpose] ?? payment.purpose}{payment.method ? `, ${METHOD_LABELS[payment.method] ?? payment.method}` : ''}</span>
                    <span className="row-money">{formatPaise(payment.amountPaise)}</span>
                  </div>
                  <Badges items={[{ tone: status.tone, text: status.label }, payment.needsReview && { tone: 'bad', text: 'Needs review' }]} />
                  <span className="order-line-meta">
                    {[
                      fee ? `Gateway fee ${formatPaise(fee)} at cost` : '',
                      TRANSFER[payment.transferStatus] ? `${TRANSFER[payment.transferStatus]} ${payment.transferPaise ? formatPaise(payment.transferPaise) : ''}`.trim() : '',
                      payment.reversedPaise ? `${formatPaise(payment.reversedPaise)} taken back` : '',
                      payment.capturedAt ? `Captured ${formatDateTime(payment.capturedAt)}` : `Started ${formatDateTime(payment.createdAt)}`,
                    ].filter(Boolean).join(' · ')}
                  </span>
                  {payment.gatewayPaymentId && <span className="order-line-meta store-break">Gateway reference {payment.gatewayPaymentId}</span>}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title="No payment yet">{order.paymentMode === 'cod' ? 'The courier collects the money at the door.' : 'It shows here once the customer pays.'}</EmptyState>
        ))}
      </StoreScreen>
    </Panel>
  );
}

/**
 * The owner's refund, in a sheet: the amount, why, how it was paid back for cash on delivery, and the owner's own password
 * again (5.11). One key per opening, so a second tap is the same refund.
 */
export function RefundButton({ order, returnId, suggestedPaise, label = 'Refund', variant = 'outline', onDone }) {
  const sheet = useRef(null);
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const most = refundable(order);
  const start = suggestedPaise > 0 ? Math.min(suggestedPaise, most) : most;
  const form = useForm({ amount: paiseToRupees(start), reason: '', reference: '', password: '', paymentId: '' }, { rename: { amountPaise: 'amount' } });
  const [key, setKey] = useState(() => freshKey('refund'));
  const payments = useQuery({ queryKey: paymentsKey(order.id), queryFn: () => api.payments.forOrder(order.id) });
  const captured = (payments.data?.items ?? []).filter((payment) => payment.status === 'captured' && payment.amountPaise > payment.refundedPaise);
  const byHand = order.paymentMode === 'cod' || captured.some((payment) => payment.provider === 'cod');

  function open() {
    form.set('amount', paiseToRupees(start));
    form.set('password', '');
    setKey(freshKey('refund'));
    sheet.current?.showModal();
  }

  async function submit(event) {
    event.preventDefault();
    const amountPaise = rupeesToPaise(form.values.amount);
    const found = {};
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) found.amount = 'Enter an amount to refund';
    else if (amountPaise > most) found.amount = `You can refund at most ${formatPaise(most)}`;
    if (!form.values.password) found.password = 'Enter your password';
    if (Object.keys(found).length) return form.reject(found);
    const body = {
      amountPaise,
      reason: form.values.reason.trim(),
      idempotencyKey: key,
      password: form.values.password,
      ...(form.values.reference.trim() ? { reference: form.values.reference.trim() } : {}),
      ...(form.values.paymentId ? { paymentId: Number(form.values.paymentId) } : {}),
      ...(returnId ? { returnId } : {}),
    };
    let refund = null;
    const done = await form.run(async () => {
      refund = await api.refunds.create(order.id, body);
    });
    if (done) {
      sheet.current?.close();
      toast(refund?.status === 'failed' ? 'The gateway refused the refund. Try it again from Refunds.' : `Refund of ${formatPaise(amountPaise)} started.`);
      await refresh();
      onDone?.(refund);
    } else {
      form.set('password', '');
    }
    return undefined;
  }

  if (most <= 0) return null;
  return (
    <>
      <Button variant={variant} onClick={open}>{label}</Button>
      <Sheet ref={sheet} title={`Refund order ${order.orderNumber}`}>
        <form className="stack" onSubmit={submit} noValidate>
          <p className="sheet-text">Up to {formatPaise(most)} can go back to the customer, the way they paid.</p>
          <FieldGroup>
            <RupeeField label="Amount" {...form.field('amount')} />
            {captured.length > 1 && (
              <SelectField label="From which payment" {...form.field('paymentId')}>
                <option value="">Let us choose</option>
                {captured.map((payment) => <option key={payment.id} value={payment.id}>{PAYMENT_PURPOSE[payment.purpose] ?? payment.purpose}, {formatPaise(payment.amountPaise - payment.refundedPaise)} left</option>)}
              </SelectField>
            )}
            <TextField label="Why (optional)" maxLength={300} {...form.field('reason')} />
            {byHand && <TextField label="How you paid it back" hint="Cash on delivery is refunded by you. Enter the UPI reference or receipt number." maxLength={100} {...form.field('reference')} />}
            <TextField label="Your password" type="password" autoComplete="current-password" hint="Refunds need your password each time." {...form.field('password')} />
          </FieldGroup>
          {form.message && <Banner tone="bad">{form.message}</Banner>}
          <div className="sheet-actions">
            <Button variant="outline" onClick={() => sheet.current?.close()}>Cancel</Button>
            <Button type="submit" variant="danger" loading={form.busy}>Refund now</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

export function OrderRefunds({ order }) {
  const allowed = useAllowed();
  const isOwner = allowed(OWNER_ONLY);
  const refunds = useQuery({ queryKey: refundsKey(order.id), queryFn: () => api.refunds.forOrder(order.id) });
  const action = useAction();
  const canRefund = order.flow === 'checkout' && refundable(order) > 0;

  return (
    <Panel title="Refunds" action={isOwner && canRefund ? <RefundButton order={order} /> : null}>
      {!isOwner && canRefund && <p className="muted">Only the owner can refund.</p>}
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <StoreScreen query={refunds} label="Loading the refunds" errorTitle="We couldn’t load the refunds">
        {({ items }) => (items.length ? (
          <div>
            {items.map((refund) => {
              const status = statusOf(REFUND, refund.status);
              return (
                <div key={refund.id} className="order-line">
                  <div className="order-line-head">
                    <span className="order-line-title">{refund.method === 'manual' ? 'Paid back by you' : 'Through the gateway'}</span>
                    <span className="row-money">{formatPaise(refund.amountPaise)}</span>
                  </div>
                  <Badges items={[{ tone: status.tone, text: status.label }, REVERSAL[refund.reversalStatus] && { tone: refund.reversalStatus === 'failed' ? 'bad' : 'neutral', text: REVERSAL[refund.reversalStatus] }]} />
                  <span className="order-line-meta">
                    {[refund.reason, refund.reference && `Reference ${refund.reference}`, formatDateTime(refund.processedAt ?? refund.createdAt)].filter(Boolean).join(' · ')}
                  </span>
                  {isOwner && refund.status === 'failed' && refund.method === 'gateway' && (
                    <div className="row-actions">
                      <Button variant="soft" loading={action.busy === `retry-${refund.id}`} onClick={() => action.run(`retry-${refund.id}`, () => api.refunds.retry(refund.id), 'Refund sent again.')}>Try again</Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title="No refunds">{canRefund ? 'A refund goes back the way the customer paid.' : 'Nothing has been paid that could be refunded.'}</EmptyState>
        ))}
      </StoreScreen>
    </Panel>
  );
}
