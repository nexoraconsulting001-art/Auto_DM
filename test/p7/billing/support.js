// What the billing tests share: the real app on a fresh database, the Razorpay simulator sending subscription events to the
// billing webhook, Bhava's invoice details set, and businesses with their owners signed in (PRD 3, 5.12).
import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import { BILLING_WEBHOOK } from '../../../src/contracts/billing.js';
import { SIGNATURE_HEADERS } from '../../../src/contracts/store-routes.js';
import { billingFor } from '../../../src/modules/billing/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createRazorpay as createRazorpaySim } from '../../../tools/sim/razorpay/index.mjs';
import { addBusiness, hit, need, signIn, startWorld } from '../../p0/spec-p0/support.js';

export const DAY = 86_400_000;
/** Bhava's own details on its invoices: Karnataka. */
export const BHAVA = { legal_name: 'Bhava Commerce Private Limited', gstin: '29ABCDE1234F1Z5', state_code: '29', address: 'Bengaluru', sac: '998314' };

let serial = 0;

export async function openBilling(t, { settings = BHAVA, overrides = {} } = {}) {
  const rzp = createRazorpaySim();
  await rzp.start();
  t.after(() => rzp.close());
  const app = await startWorld(t, {
    overrides: {
      razorpayBaseUrl: rzp.url, razorpayAuthBaseUrl: rzp.url, razorpayKeyId: rzp.keyId, razorpayKeySecret: rzp.keySecret, razorpayWebhookSecret: rzp.webhookSecret,
      razorpayBillingWebhookSecret: rzp.billingWebhookSecret, providerTimeoutMs: 1500, ...overrides,
    },
  });
  t.after(async () => {
    await billingFor(app.ctx).webhooks.settle().catch(() => {});
  });
  await rzp.post('/billing/webhook-url', { url: `${app.base}${BILLING_WEBHOOK.path}` });
  if (settings) {
    const keys = Object.keys(settings);
    await app.db.platform.query(`UPDATE billing_settings SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}`, keys.map((k) => settings[k]));
  }
  const world = { app, rzp, billing: billingFor(app.ctx) };
  world.sql = (text, params = []) => app.db.platform.query(text, params);
  world.one = async (text, params = []) => (await world.sql(text, params))[0];
  world.settle = async () => {
    for (let i = 0; i < 2; i++) await world.billing.webhooks.settle();
  };

  /** A business with its owner signed in (a fresh session). `state` is its GST state on its own invoice settings. */
  world.business = async ({ plan = 'free', state = null, slug = `shop${++serial}${crypto.randomBytes(2).toString('hex')}` } = {}) => {
    const b = await addBusiness(app, { slug, name: `Shop ${slug}`, plan });
    if (state) await withTenant(b.tenant, () => app.db.query(`INSERT INTO invoice_settings (tenant_id, legal_name, state_code) VALUES ($1, $2, $3)`, [b.tenant.id, `Shop ${slug} LLP`, state]));
    b.token = await signIn(app, b);
    b.api = async (method, path, body, { token = b.token, headers } = {}) => {
      const res = await hit(app, `/api/v1${path}`, { host: b.host, method, body, token, headers });
      return { status: res.status, json: res.text ? JSON.parse(res.text) : null, text: res.text, headers: res.headers };
    };
    b.in = (fn) => withTenant(b.tenant, fn);
    b.sub = () => world.one('SELECT * FROM subscriptions WHERE tenant_id = $1', [b.tenant.id]);
    b.tenantRow = () => world.one('SELECT plan, billing_cycle FROM tenants WHERE id = $1', [b.tenant.id]);
    b.invoices = () => world.sql('SELECT * FROM bhava_invoices WHERE tenant_id = $1 ORDER BY id', [b.tenant.id]);
    b.lines = (invoiceId) => world.sql('SELECT * FROM bhava_invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY position', [b.tenant.id, invoiceId]);
    b.payments = () => world.sql('SELECT * FROM billing_payments WHERE tenant_id = $1 ORDER BY id', [b.tenant.id]);
    b.key = () => `rk-${crypto.randomUUID()}`;
    /** Picks a plan as the owner. */
    b.change = async (plan, cycle) => b.api('POST', '/billing/change', { plan, ...(cycle ? { cycle } : {}), requestKey: b.key() });
    /** The payer finishes the hosted page and the provider takes a charge. Options go to the simulator (duplicates, hold, signature). */
    b.charge = async (options = {}) => {
      const s = await b.sub();
      await rzp.post('/subscriptions/authorize', { id: s.provider_subscription_id });
      const out = await rzp.post('/subscriptions/charge', { id: s.provider_subscription_id, ...options });
      await world.settle();
      return out;
    };
    /** A paid plan, charged once. */
    b.subscribe = async (plan = 't1', cycle = 'monthly') => {
      need({ status: (await b.change(plan, cycle)).status, text: '' }, 200, `change to ${plan}`);
      return b.charge();
    };
    return b;
  };

  /** A billing webhook posted by hand with any signature. */
  world.hook = (body, { signature, eventId = `evt_${crypto.randomBytes(6).toString('hex')}` } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const sig = signature === undefined ? crypto.createHmac('sha256', rzp.billingWebhookSecret).update(raw).digest('hex') : signature;
    return hit(app, BILLING_WEBHOOK.path, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...(sig === null ? {} : { [SIGNATURE_HEADERS.razorpay]: sig }), [SIGNATURE_HEADERS.razorpayEventId]: eventId } });
  };
  world.events = () => world.sql(`SELECT * FROM provider_webhook_events WHERE scope = 'billing' ORDER BY id`);
  return world;
}

/** An addon purchase body. */
export const item = (code, extra = {}) => ({ code, requestKey: `rk-${crypto.randomUUID()}`, ...extra });
