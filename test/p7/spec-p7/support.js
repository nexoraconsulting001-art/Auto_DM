// Shared by the Phase 7 spec tests. Written from the PRD (3, 5.6 to 5.10, 5.12, 5.17, 5.20, 6.11, 6.12) and the Phase 7 contract
// only (src/contracts/billing.js, services.js, onboarding.js, health.js, addons.js, api/*, the tables of migrations 700 to 770 and
// the simulators in tools/sim). Nothing here looks inside a module. Tests talk HTTP, the database and the simulators.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before } from 'node:test';
import { BILLING_WEBHOOK } from '../../../src/contracts/billing.js';
import { SIGNATURE_HEADERS } from '../../../src/contracts/store-routes.js';
import { addP4Shop, consoleUser, hit, need, onConsole, openP4World, pause, unique } from '../../p4/spec-p4/kit.js';
import { NEUTRAL } from '../../p0/spec-p0/support.js';

export * from '../../p4/spec-p4/kit.js';
export { BILLING_WEBHOOK, SIGNATURE_HEADERS };
export { linksIn } from '../../p0/spec-p0/support.js';

export const APP = `app.${NEUTRAL}`;
export const DAY = 86_400_000;
export const json = (res) => {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
};
export const sql = (world, text, params = []) => world.rawDb.platform.query(text, params);
export const one = async (world, text, params = []) => (await sql(world, text, params))[0];
export const key = () => `req_${crypto.randomBytes(8).toString('hex')}`;

/**
 * D-4: the Instagram callback saves nothing; the person who started the connect finishes it in their own session. A
 * token start (the owner app) comes back with instagram=finish and finishes with POST /instagram/connect/finish; a
 * console start goes on to /oauth/instagram/finish on its own host, with its cookie. `done` is the callback's answer;
 * `send(method, path, body)` calls the API as the starter. Returns the outcome (connected, taken, ...), or null.
 */
export async function finishConnect(world, done, { send, cookie, host } = {}) {
  const at = (location) => (location ? new URL(location, 'http://relative.invalid') : null);
  const next = at(done?.headers?.location);
  if (!next) return null;
  if (next.searchParams.get('instagram') === 'finish') {
    const finished = await send('POST', '/instagram/connect/finish', { finishToken: next.searchParams.get('f') });
    return json(finished)?.outcome ?? null;
  }
  if (next.pathname === '/oauth/instagram/finish') {
    const landed = await hit(world, `${next.pathname}${next.search}`, { host, cookie });
    return at(landed.headers.location)?.searchParams.get('instagram') ?? null;
  }
  return next.searchParams.get('instagram');
}
/** Never a server error, and never a success. */
export const refusal = (res, what, statuses) => {
  assert.ok(res.status >= 400 && res.status < 500, `${what}: expected a refusal, got HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  if (statuses) assert.ok([statuses].flat().includes(res.status), `${what}: expected HTTP ${[statuses].flat().join(' or ')}, got ${res.status}: ${res.text.slice(0, 300)}`);
  return res;
};
export const code = (res) => json(res)?.code ?? '';

// ---- the world ------------------------------------------------------------------------------------------------------------

export const BILLING_SECRET = 'sim-billing-webhook-secret';

/** The Phase 4 world with Bhava's own billing account pointed at the Razorpay simulator, and Bhava's legal details filled in. */
export async function openBillingWorld({ overrides = {}, ...options } = {}) {
  const world = await openP4World({
    ...options,
    overrides: { razorpayBillingKeyId: 'rzp_test_sim', razorpayBillingKeySecret: 'sim-key-secret', razorpayBillingWebhookSecret: BILLING_SECRET, billingReturnUrl: `https://${APP}/billing`, ...overrides },
  });
  await world.rzp.post('/billing/webhook-url', { url: `${world.base}${BILLING_WEBHOOK.path}` });
  await legalDetails(world);
  return world;
}

export async function legalDetails(world, patch = {}) {
  const row = { legal_name: 'Bhava Test Private Limited', gstin: '27ABCDE1234F1Z5', state_code: '27', address: '1 Test Road, Mumbai', sac: '998439', ...patch };
  const names = Object.keys(row);
  await sql(world, `UPDATE billing_settings SET ${names.map((n, i) => `${n} = $${i + 1}`).join(', ')}`, names.map((n) => row[n]));
}

export const setSetting = (world, column, value) => sql(world, `UPDATE billing_settings SET ${column} = $1`, [value]);

/** One world per test file, opened before its first test. */
export function useBillingWorld(options) {
  let current;
  before(async () => { current = await openBillingWorld(options); });
  after(async () => { await current?.close(); });
  return new Proxy({}, { get: (_, name) => current?.[name] });
}

/** A business on `plan` with the Phase 4 store set up. */
export async function shopOn(world, plan = 't3', options = {}) {
  return addP4Shop(world, { plan, ...options });
}

// ---- billing ------------------------------------------------------------------------------------------------------------------

export const subscriptionOf = (world, shop) => one(world, 'SELECT * FROM subscriptions WHERE tenant_id = $1', [shop.tenantId]);
export const invoicesOf = (world, shop) => sql(world, `SELECT * FROM bhava_invoices WHERE tenant_id = $1 ORDER BY id`, [shop.tenantId]);
export const linesOf = (world, invoiceId) => sql(world, 'SELECT * FROM bhava_invoice_lines WHERE invoice_id = $1 ORDER BY position', [invoiceId]);
export const paymentsOf = (world, shop) => sql(world, 'SELECT * FROM billing_payments WHERE tenant_id = $1 ORDER BY id', [shop.tenantId]);
export const planOf = async (world, shop) => (await one(world, 'SELECT plan, billing_cycle FROM tenants WHERE id = $1', [shop.tenantId]));
export const tenantStatus = async (world, shop) => (await one(world, 'SELECT status FROM tenants WHERE id = $1', [shop.tenantId])).status;

/** Asks the seller API to change plan and returns the answer. The client never sends a price. */
export const change = (shop, plan, cycle, requestKey = key()) => shop.send('POST', '/billing/change', { plan, ...(cycle ? { cycle } : {}), requestKey });

/** The payer finishes the provider's hosted page, as the simulator does it. */
export async function authorize(world, shop) {
  const sub = await subscriptionOf(world, shop);
  assert.ok(sub?.provider_subscription_id, 'The change made no provider subscription');
  await world.rzp.post('/subscriptions/authorize', { id: sub.provider_subscription_id });
  return sub;
}

/** The provider takes a payment: a renewal on its clock. Returns the simulator's answer. */
export async function charge(world, shop, options = {}) {
  const sub = await subscriptionOf(world, shop);
  assert.ok(sub?.provider_subscription_id, 'The business has no provider subscription');
  return world.rzp.post('/subscriptions/charge', { id: sub.provider_subscription_id, ...options });
}

/** Moves a business to a paid plan the way an owner does, pays, and waits for the invoice. Returns { sub, invoice }. */
export async function subscribe(world, shop, plan = 't1', { cycle = 'monthly' } = {}) {
  need(await change(shop, plan, cycle), 200, `Choosing ${plan}`);
  await authorize(world, shop);
  await charge(world, shop);
  const invoice = await world.until(async () => (await invoicesOf(world, shop))[0]);
  assert.ok(invoice, 'A captured charge made no invoice');
  return { sub: await subscriptionOf(world, shop), invoice };
}

/** A Razorpay subscription event posted by hand, signed with Bhava's billing secret unless told otherwise. */
export function billingHook(world, event, entities, { eventId = `evt_spec_${unique()}`, secret = BILLING_SECRET, signature, createdAt } = {}) {
  const raw = JSON.stringify({ event, created_at: createdAt ?? Math.floor(Date.now() / 1000), payload: entities });
  const sig = signature === undefined ? crypto.createHmac('sha256', secret).update(raw).digest('hex') : signature;
  return hit(world, BILLING_WEBHOOK.path, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { [SIGNATURE_HEADERS.razorpay]: sig }), [SIGNATURE_HEADERS.razorpayEventId]: eventId }, body: raw });
}

export const chargedEntities = (subscriptionId, paymentId, amount = 59_882) => ({
  subscription: { entity: { id: subscriptionId, status: 'active', current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 30 * 86_400 } },
  payment: { entity: { id: paymentId, entity: 'payment', amount, currency: 'INR', status: 'captured', method: 'card', captured: true, created_at: Math.floor(Date.now() / 1000) } },
});

/** Bhava's invoice as the database numbers it. Written in one transaction with one line, as the contract says an invoice must be. */
export async function issueInvoice(world, shop, { at, sourceRef = `spec:${unique()}`, taxable = 10_000, igst = false } = {}) {
  return world.rawDb.platform.tx(async (t) => {
    const tax = Math.floor((taxable * 900 + 5000) / 10_000);
    const parts = igst ? { cgst: 0, sgst: 0, igst: Math.floor((taxable * 1800 + 5000) / 10_000) } : { cgst: tax, sgst: tax, igst: 0 };
    const [inv] = await t.query(
      `INSERT INTO bhava_invoices (tenant_id, doc_type, fy, seq, number, issued_at, source_ref, seller, buyer, place_of_supply, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
       VALUES ($1, 'invoice', 0, 0, '', $2, $3, '{}'::jsonb, '{}'::jsonb, '27', $4, $5, $6, $7, $8) RETURNING *`,
      [shop.tenantId, at ?? new Date(), sourceRef, taxable, parts.cgst, parts.sgst, parts.igst, taxable + parts.cgst + parts.sgst + parts.igst],
    );
    await t.query(
      `INSERT INTO bhava_invoice_lines (tenant_id, invoice_id, position, kind, code, description, quantity, unit_paise, gross_paise, taxable_paise, rate_bp, cgst_paise, sgst_paise, igst_paise)
       VALUES ($1, $2, 1, 'plan', 't1', 'Plan', 1, $3, $3, $3, 1800, $4, $5, $6)`,
      [shop.tenantId, inv.id, taxable, parts.cgst, parts.sgst, parts.igst],
    );
    return inv;
  });
}

/** Seller-side meter: what the owner sees at /billing/usage for the DM meter. */
export async function dmMeter(shop) {
  const res = need(await shop.send('GET', '/billing/usage'), 200, 'Reading the usage meter');
  return json(res).meters.find((m) => m.meter === 'dms');
}

/** Sets this month's DM count for a business directly, as the sum of uncounted past sends (one usage event with a quantity). */
export async function setDmUsed(world, shop, used, { included } = {}) {
  await sql(world, `DELETE FROM usage_events WHERE tenant_id = $1 AND meter = 'dms'`, [shop.tenantId]);
  await sql(world, `DELETE FROM usage_months WHERE tenant_id = $1 AND meter = 'dms'`, [shop.tenantId]);
  if (used > 0) await sql(world, `INSERT INTO usage_events (tenant_id, meter, quantity, idempotency_key, occurred_at) VALUES ($1, 'dms', $2, $3, now())`, [shop.tenantId, used, `seed:${unique()}`]);
  if (included !== undefined) await sql(world, `UPDATE usage_months SET included = $2 WHERE tenant_id = $1 AND meter = 'dms'`, [shop.tenantId, included]);
}

/** One automated DM: a comment on a live automation, then the queue. Returns the DMs that went out. */
export async function sendOneDm(world, shop, automation, { text = 'price' } = {}) {
  const before_ = (await shop.dms()).length;
  await shop.comment(automation.mediaId, { text });
  await shop.settle();
  return (await shop.dms()).length - before_;
}

// ---- operators ------------------------------------------------------------------------------------------------------------------

export { consoleUser, onConsole };
export const opCall = (world, op, method, path, body) => onConsole(world, op, path, { method, ...(body === undefined ? {} : { body }) });

/** The seller cookie session a one-time address opens, with a caller for the seller API as the operator sees it. */
export async function openSession(world, shop, startedAnswer) {
  const url = new URL(startedAnswer.url, `https://${shop.host}`);
  const entry = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.ok(entry.status < 400, `The one-time address answered ${entry.status}: ${entry.text.slice(0, 200)}`);
  const cookie = String(entry.headers['set-cookie'] ?? '').split(';')[0];
  assert.ok(cookie, 'The one-time address set no session cookie');
  const me = await hit(world, '/api/v1/auth/me', { host: shop.host, cookie });
  const csrf = me.status === 200 ? json(me).csrf ?? '' : '';
  const call = async (method, path, body, headers = {}) => {
    const res = await hit(world, `/api/v1${path}`, { host: shop.host, cookie, method, ...(body === undefined ? {} : { body }), headers: { 'x-csrf-token': csrf, ...headers } });
    return Object.assign(res, { data: json(res) });
  };
  return { cookie, csrf, me, call, url };
}

export async function impersonate(world, shop, op, reason = 'ticket 123') {
  const res = need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason }), [200, 201], 'Starting an impersonation');
  const started = json(res);
  return { started, ...(await openSession(world, shop, started)) };
}

export async function startService(world, shop, op, service, taskRef = 'TASK-1') {
  const res = need(await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/service-sessions`, { service, taskRef }), 201, `Starting a ${service} session`);
  const started = json(res);
  return { started, ...(await openSession(world, shop, started)) };
}

export const grantService = (shop, service, enabled = true) => sql(shop.world, `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, $2, $3, NULL) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`, [shop.tenantId, `service.${service}`, enabled]);

// ---- self-serve sign-up --------------------------------------------------------------------------------------------------------

/** Each person signs in from a device of their own, so the file's one loopback address is not shared by every person it makes. */
let personsMade = 0;
export const newAddress = () => `203.0.${113 + Math.floor(personsMade / 250)}.${1 + (personsMade++ % 250)}`;

/** Signs a person in on the sign-in host with a WhatsApp code. No business yet. Returns a caller for the host. */
export async function appSignIn(world, phone, host = APP) {
  const from = newAddress();
  const headers ={ 'x-forwarded-host': host, 'x-forwarded-for': from, 'content-type': 'application/json' };
  const start = await hit(world, '/api/v1/auth/start', { host, method: 'POST', headers, body: { phone } });
  assert.equal(start.status, 202, `auth.start answered ${start.status}: ${start.text.slice(0, 200)}`);
  const otp = await world.codeFor(phone);
  const verify = need(await hit(world, '/api/v1/auth/verify', { host, method: 'POST', headers, body: { phone, code: otp, transport: 'cookie' } }), 201, 'auth.verify');
  const cookie = String(verify.headers['set-cookie']).split(';')[0];
  const csrf = json(verify).csrf;
  const call = async (method, path, body, extra = {}) => {
    const res = await hit(world, `/api/v1${path}`, { host, cookie, method, ...(body === undefined ? {} : { body }), headers: { 'x-csrf-token': csrf, 'x-forwarded-for': from, ...extra } });
    return Object.assign(res, { data: json(res) });
  };
  return { phone, cookie, csrf, call };
}

export async function setSignup(world, mode, op) {
  const admin = op ?? (await consoleUser(world));
  need(await opCall(world, admin, 'PUT', '/signup', { mode, reason: 'spec' }), 200, `Setting sign-up to ${mode}`);
  return admin;
}

export async function newInvite(world, op, { maxUses = 1, expiresInDays } = {}) {
  const res = need(await opCall(world, op, 'POST', '/signup/invites', { note: 'spec', maxUses, ...(expiresInDays ? { expiresInDays } : {}) }), 201, 'Making a sign-up invite');
  return json(res);
}

export { assert, pause, unique, need, hit };

/** The platform's name must never reach a shopper. */
export function assertSellerBrand(value, what) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(text, /bhava/i, `${what} carries the platform's name`);
}

/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 second steps) from a base32 secret, as any authenticator app computes it from an
 * otpauth:// address with no parameters. Written here from the RFC, so the console's second factor is checked against the
 * standard rather than against its own code.
 */
export function totp(secret, ms = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(secret).toUpperCase().replace(/[\s=-]/g, '')) {
    const v = alphabet.indexOf(ch);
    assert.ok(v >= 0, 'The enrolment secret is not base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const keyBytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = crypto.createHmac('sha1', keyBytes).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** A Razorpay payment entity for a subscription charge, as a hand-signed billing webhook carries it, paid with one card. */
export const cardCharge = (subscriptionId, cardId, amount = 59_882) => {
  const entities = chargedEntities(subscriptionId, `pay_card_${unique()}`, amount);
  Object.assign(entities.payment.entity, { card_id: cardId, token_id: `token_${cardId}`, card: { id: cardId, last4: '1111', network: 'Visa', type: 'credit' } });
  return entities;
};

/** Removes every fault a test put on a simulator, through its control address. */
export async function clearFaults(sim) {
  const res = await fetch(sim.url + '/__sim/faults', { method: 'DELETE' });
  assert.ok(res.status < 300, 'Clearing the simulator faults answered ' + res.status);
}
