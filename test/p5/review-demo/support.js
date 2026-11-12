// What the review-demo tests share: one app with the review login configured, the demo business service, calls on
// the sign-in host, and a snapshot of everything the demo business holds.
import crypto from 'node:crypto';
import { codeHash } from '../../../src/contracts/accounts.js';
import { demoTenantService } from '../../../src/modules/demo-tenant/index.js';
import { APP_HOST, startApp, testDevice } from '../../helpers.js';

export const REVIEW_PHONE = '+919000000099';
export const REVIEW_LOCAL = '9000000099';
export const REVIEW_CODE = '424242';

let nextIp = 1;
const freshIp = () => `10.77.${(nextIp >> 8) & 255}.${nextIp++ & 255}`;

/** A test app with the review login on, and the demo business service for its database. */
export async function reviewApp({ now } = {}) {
  const hash = codeHash('test-secret', { purpose: 'signin', subject: REVIEW_PHONE, code: REVIEW_CODE });
  const app = await startApp({ overrides: { reviewLoginPhone: REVIEW_PHONE, reviewLoginCodeHash: hash } });
  const demo = demoTenantService({ db: app.db, repos: app.platform, config: app.config, ...(now ? { now } : {}) });
  return { ...app, demo };
}

/** One request to the app; `host` defaults to the sign-in host. */
export async function call(app, pathname, { method = 'GET', headers = {}, body, host = APP_HOST } = {}) {
  const res = await fetch(`${app.base}${pathname}`, {
    method,
    headers: { 'x-forwarded-host': host, 'x-forwarded-for': freshIp(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text };
}

/** Tries a code on a number through the app's sign-in route. */
export const verify = (app, phone, code) => call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone, code, device: testDevice('Review iPad', crypto.randomBytes(16).toString('hex')) } });

/** Signs in with the review login and returns the session plus bearer headers. */
export async function reviewSession(app) {
  const res = await verify(app, REVIEW_LOCAL, REVIEW_CODE);
  if (res.status !== 201) throw new Error(`review sign-in answered ${res.status}: ${res.text.slice(0, 200)}`);
  return { ...res.json, headers: { authorization: `Bearer ${res.json.accessToken}` } };
}

/** The tables the sample writes, each read as rows of JSON in a fixed order. */
export const SAMPLE_TABLES = Object.freeze([
  'settings', 'products', 'reels', 'reel_products', 'ig_accounts', 'analytics_accounts', 'insight_daily', 'insight_demographics', 'insight_online_followers',
  'insight_media', 'automations', 'automation_triggers', 'message_templates', 'template_variants', 'inbox_threads', 'inbox_messages', 'needs_human_items',
  'orders', 'order_items', 'order_status_history', 'order_events', 'compliance_settings',
]);

/**
 * Everything the demo business holds in SAMPLE_TABLES, without what is bound to change between two writes: serial ids
 * and the ids that point at them, the business's keyed hashes and salt, and the moments the database stamps itself.
 */
export async function snapshot(db, tenantId) {
  const drop = (key) => key === 'id' || key.endsWith('_id') || key.endsWith('_ref') || key === 'subject_hash' || key === 'subject' || key === 'subject_salt'
    || key === 'paused_at' || key === 'updated_at';
  const out = {};
  for (const table of SAMPLE_TABLES) {
    const rows = await db.platform.query(`SELECT to_jsonb(x) AS j FROM ${table} x WHERE tenant_id = $1`, [tenantId]);
    out[table] = rows.map(({ j }) => Object.fromEntries(Object.entries(j).filter(([k]) => !drop(k)))).map((r) => JSON.stringify(r)).sort();
  }
  return out;
}
