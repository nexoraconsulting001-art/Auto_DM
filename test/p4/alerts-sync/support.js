// What the alerts-sync track's tests share: an app whose store providers are the simulators (WhatsApp, an HTTP mail API,
// Shopify Admin, Razorpay), with the default business on tier 3 with its store ready, WhatsApp connected and its templates
// approved. Requests go through the real HTTP stack; time-of-day rules take an explicit clock where they need one.
import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import { createEmail } from '../../../tools/sim/email/index.mjs';
import { createRazorpay } from '../../../tools/sim/razorpay/index.mjs';
import { createShopify } from '../../../tools/sim/shopify/index.mjs';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { withTenant } from '../../../src/tenancy.js';
import { csrfFor } from '../../../src/modules/shoppers/keys.js';
import { OWNER } from '../../helpers.js';
import { hit, inTenant, markPaid, otherStore, payments, place, placeBody, product, q, setPlan, shopper, storeApp } from '../checkout/support.js';

export { hit, inTenant, markPaid, otherStore, payments, place, placeBody, product, q, setPlan, shopper };
export const NEUTRAL_MAIL = 'mail-neutral.example';
export const IST_MS = 5.5 * 3_600_000;
export const HOUR = 3_600_000;

/** The platform's own name, which nothing a shopper receives may carry. */
export const PLATFORM = /bhava/i;

/** An app with every store provider on a simulator. `whatsapp: false` leaves WhatsApp unconnected. */
export async function alertsApp({ whatsapp = true, overrides = {} } = {}) {
  const sims = { wa: createWhatsApp(), mail: createEmail(), shopify: createShopify(), rzp: createRazorpay() };
  for (const sim of Object.values(sims)) await sim.start();
  const app = await storeApp({
    overrides: {
      providerTimeoutMs: 1500,
      // A neutral platform domain: links built on it must not carry the platform's name.
      platformDomain: 'shops.example',
      whatsappBaseUrl: sims.wa.url,
      whatsappAppSecret: sims.wa.appSecret,
      whatsappVerifyToken: 'wa-verify',
      emailDriver: 'http',
      emailBaseUrl: sims.mail.url,
      emailHosts: sims.mail.url,
      emailApiKey: 'sim-email-key',
      emailNeutralDomain: NEUTRAL_MAIL,
      shopifyBaseUrl: sims.shopify.url,
      razorpayBaseUrl: sims.rzp.url,
      razorpayAuthBaseUrl: sims.rzp.url,
      razorpayKeyId: sims.rzp.keyId,
      razorpayKeySecret: sims.rzp.keySecret,
      razorpayWebhookSecret: sims.rzp.webhookSecret,
      ...overrides,
    },
  });
  await sims.mail.post('/dkim', { domain: NEUTRAL_MAIL, pass: true });
  await payments(app);
  const token = (await hit(app, '/api/v1/auth/login', { method: 'POST', body: OWNER })).json.token;
  const api = (method, path, body, opts = {}) => hit(app, `/api/v1${path}`, { method, body, token: opts.token ?? token, host: opts.host });
  const close = app.close;
  Object.assign(app, { ...sims, token, api, sims, close: async () => { close(); for (const sim of Object.values(sims)) await sim.close(); } });
  if (whatsapp) await connectWhatsapp(app);
  return app;
}

/** Connects WhatsApp through the console API and gets every template approved, as Meta's review would. */
export async function connectWhatsapp(app, { phoneNumberId = `ph${crypto.randomInt(1e6, 9e6)}`, api = app.api } = {}) {
  const res = await api('PUT', '/whatsapp-account', { wabaId: `waba${crypto.randomInt(1e6, 9e6)}`, phoneNumberId, accessToken: 'sim-whatsapp-token', displayNumber: '+919000000000' });
  if (res.status !== 200) throw new Error(`Connecting WhatsApp: ${res.status} ${res.text}`);
  const first = await api('POST', '/whatsapp-templates/sync');
  for (const t of first.json.items) await app.wa.post('/templates', { name: t.name, language: t.language, category: t.category, status: 'APPROVED' });
  await api('POST', '/whatsapp-templates/sync');
  return phoneNumberId;
}

/** Saves a shopper's consent choices, as the account page does. */
export async function consentOf(app, subject, { orderUpdates = {}, marketing = {} } = {}, tenant = app.tenant) {
  const choices = [];
  for (const [channel, granted] of Object.entries(orderUpdates)) choices.push({ purpose: 'order_updates', channel, granted });
  for (const [channel, granted] of Object.entries(marketing)) choices.push({ purpose: 'marketing', channel, granted });
  if (!choices.length) return;
  await withTenant(tenant, () => app.ctx.platform.consent.record({ subject, choices, noticeVersion: 1, source: 'account' }));
}

/**
 * A prepaid order placed through checkout and paid. `consent` is what the checkout form says. Returns the order row.
 */
export async function paidOrder(app, { productId, qty = 1, phone = '+919876543210', email = 'asha@mail.example', consent = { orderUpdates: { whatsapp: true, email: true } }, cookie, tenant = app.tenant } = {}) {
  const body = placeBody(productId, { lines: [{ productId, variantId: null, qty }], address: { name: 'Asha Rao', phone, line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' }, email, consent: { noticeVersion: 1, ...consent } });
  const res = await place(app, body, { cookie });
  if (res.status !== 201 && res.status !== 200) throw new Error(`Placing an order: ${res.status} ${res.text}`);
  const [order] = await q(app, 'SELECT * FROM orders WHERE tenant_id = $1 AND order_number = $2', [tenant.id, res.json.orderNumber], tenant);
  await app.ctx.orderEvents.settle();
  await markPaid(app, order.id, { tenant });
  await app.ctx.orderEvents.settle();
  return (await q(app, 'SELECT * FROM orders WHERE tenant_id = $1 AND id = $2', [tenant.id, order.id], tenant))[0];
}

export const alertsOf = (app, orderId, tenant = app.tenant) => q(app, 'SELECT * FROM order_alerts WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenant.id, orderId], tenant);
export const digits = (phone) => String(phone).replace(/\D/g, '');
export const whatsappTo = async (app, phone) => (await app.wa.get('/sent')).sent.filter((m) => m.to === digits(phone));
export const emailsTo = async (app, email) => (await app.mail.get('/sent')).sent.filter((m) => m.to.includes(email));

/** The most recent instant before `before` that is `hour`:00 India time. */
export function lastIst(hour, before = new Date()) {
  const local = new Date(before.getTime() + IST_MS);
  let at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour) - IST_MS;
  if (at >= before.getTime()) at -= 24 * HOUR;
  return new Date(at);
}

/** A daytime instant (2 pm India time today), for rules that read the time of day. */
export function daytime(base = new Date()) {
  const local = new Date(base.getTime() + IST_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 14) - IST_MS);
}

/** Signs a WhatsApp webhook body as Meta does. */
export function signWhatsapp(app, raw, secret = app.wa.appSecret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/** A Shopify webhook, signed with the shop's own secret unless `hmac` says otherwise. */
export function shopifyHook(app, { domain, secret, topic, payload, webhookId = crypto.randomUUID(), hmac }) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = hmac === undefined ? crypto.createHmac('sha256', secret).update(raw).digest('base64') : hmac;
  return hit(app, '/webhooks/shopify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': domain, 'x-shopify-webhook-id': webhookId, ...(sig === null ? {} : { 'x-shopify-hmac-sha256': sig }) },
    body: raw,
  });
}

export const inOther = (app, other, fn) => inTenant(app, fn, other.tenant);

/** A second business on its own address with its owner signed in: { tenant, host, api }. */
export async function otherBusiness(app, { slug = 'haldi', name = 'Haldi House', phone = '9000000009' } = {}) {
  const tenant = await app.platform.tenants.ensure({ slug, name });
  await app.db.platform.query(`UPDATE tenants SET plan = 't3' WHERE id = $1`, [tenant.id]);
  await withTenant(tenant, () => app.platform.users.ensureOwner({ phone, password: 'other-pass' }));
  const host = `${slug}.shops.example`;
  const login = await hit(app, '/api/v1/auth/login', { method: 'POST', host, body: { phone, password: 'other-pass' } });
  if (login.status !== 201 && login.status !== 200) throw new Error(`Other business sign-in: ${login.status} ${login.text}`);
  const api = (method, path, body) => hit(app, `/api/v1${path}`, { method, body, token: login.json.token, host });
  return { tenant, host, api };
}

/** The CSRF header a shopper's page sends with a write, for the session in `cookie` ("_sid=<token>"). */
export const shopperCsrf = (app, cookie) => ({ 'x-shopper-csrf': csrfFor(app.config, String(cookie).replace(/^_sid=/, '')) });
