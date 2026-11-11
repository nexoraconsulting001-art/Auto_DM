import { formatRupees } from '../../contracts/catalog.js';
import { html, raw } from '../../views/html.js';
import { firstName } from './business.js';

/**
 * What a shopper receives about an order (PRD 9.16), by WhatsApp (an approved Utility template) or email. In the seller's
 * brand only: the store's name, colour and own address; never the platform's. Links are direct links to the store's own
 * order page. Built from ids and the order row; nothing here is logged.
 */
export const TEMPLATE_OF = Object.freeze({
  placed: 'order_placed', paid: 'order_paid', shipped: 'order_shipped', delivered: 'order_delivered', cancelled: 'order_cancelled', refunded: 'order_refunded',
});

const WORDS = Object.freeze({
  placed: { subject: (n) => `Order ${n} is confirmed`, lead: 'Thank you for your order. We will write again when it ships.' },
  paid: { subject: (n) => `Payment received for order ${n}`, lead: 'We have received your payment and are getting your order ready.' },
  shipped: { subject: (n) => `Your order ${n} has shipped`, lead: 'Your order is on its way to you.' },
  delivered: { subject: (n) => `Your order ${n} has been delivered`, lead: 'Your order has been delivered. We hope you love it.' },
  cancelled: { subject: (n) => `Your order ${n} has been cancelled`, lead: 'Your order has been cancelled. If you paid for it, we will write to you about your refund.' },
  refunded: { subject: (n) => `A refund for order ${n}`, lead: 'We have processed a refund for your order.' },
});

export const orderLink = (business, order) => (business.base && order.public_token ? `${business.base}/order/${encodeURIComponent(order.public_token)}` : '');

/** The message for one alert. `unsubscribeUrl` is the shopper's one-tap way to stop order emails. */
export function orderMessage({ channel, event, order, items = [], business, unsubscribeUrl = '' }) {
  const to = { shopperId: order.shopper_id ?? undefined, phone: order.phone || undefined, email: order.email || undefined };
  const link = orderLink(business, order);
  const base = { channel, purpose: 'order_update', to, orderId: order.id };
  if (channel === 'whatsapp') {
    return { ...base, template: { purpose: TEMPLATE_OF[event], params: [firstName(order.customer_name), order.order_number, business.name, link || business.name] } };
  }
  const words = WORDS[event];
  const subject = `${business.name}: ${words.subject(order.order_number)}`;
  const amount = event === 'refunded' ? Number(order.refunded_paise ?? 0) : Number(order.total_paise ?? 0);
  const lines = items.slice(0, 20).map((i) => `${i.name}${i.option_value ? ` (${i.option_value})` : ''} × ${i.qty}`);
  const text = [
    `Hi ${firstName(order.customer_name)},`,
    '',
    words.lead,
    '',
    `Order ${order.order_number}`,
    ...lines,
    `${event === 'refunded' ? 'Refunded' : 'Total'}: ${formatRupees(amount)}`,
    ...(link ? ['', `See your order: ${link}`] : []),
    '',
    business.name,
    ...(unsubscribeUrl ? ['', `Stop order emails: ${unsubscribeUrl}`] : []),
  ].join('\n');
  const body = html`<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f4;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#ffffff;border-radius:12px;padding:24px;border-top:6px solid ${raw(business.color)}">
<h1 style="margin:0 0 16px;font-size:20px">${business.name}</h1>
<p style="margin:0 0 12px">Hi ${firstName(order.customer_name)},</p>
<p style="margin:0 0 16px">${words.lead}</p>
<p style="margin:0 0 8px;font-weight:bold">Order ${order.order_number}</p>
${lines.length ? html`<ul style="margin:0 0 12px;padding-left:18px">${lines.map((l) => html`<li>${l}</li>`)}</ul>` : ''}
<p style="margin:0 0 20px">${event === 'refunded' ? 'Refunded' : 'Total'}: <strong>${formatRupees(amount)}</strong></p>
${link ? html`<p style="margin:0 0 8px"><a href="${link}" style="display:inline-block;background:${raw(business.color)};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px">See your order</a></p>` : ''}
</div>
<p style="font-size:12px;color:#6b6b70;margin:16px 0 0">You are receiving this because you ordered from ${business.name}.${unsubscribeUrl ? html` <a href="${unsubscribeUrl}" style="color:#6b6b70">Stop order emails</a>` : ''}</p>
</div></body></html>`;
  return { ...base, email: { subject, html: String(body), text, ...(unsubscribeUrl ? { unsubscribeUrl } : {}) } };
}
