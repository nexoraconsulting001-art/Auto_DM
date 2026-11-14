// Who may touch billing (PRD 5.10, 5.11, 5.12): the owner only; changing money needs a fresh re-auth; an impersonating
// operator and a service operator are refused every billing route; one business never sees or reaches another's billing;
// the invoice file opens only by a short signed link, for its own business's owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashSessionToken } from '../../../src/repos/sessions.js';
import { addStaff, hit } from '../../p0/spec-p0/support.js';
import { item, openBilling } from './support.js';

async function operatorSession(w, shop, { kind }) {
  const sql = (text, params) => w.sql(text, params);
  const [operator] = await sql(`INSERT INTO platform_users (email, name, role) VALUES ($1, 'Meera', $2) RETURNING id`, [`${crypto.randomUUID()}@team.example`, kind === 'service' ? 'service_operator' : 'support']);
  const [owner] = await sql(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenant.id]);
  let impersonationId = null;
  let serviceSessionId = null;
  if (kind === 'impersonation') {
    [{ id: impersonationId }] = await sql(`INSERT INTO impersonation_sessions (tenant_id, operator_id, operator_name, owner_user_id, reason) VALUES ($1, $2, 'Meera', $3, 'ticket 9') RETURNING id`, [shop.tenant.id, operator.id, owner.id]);
    await sql(`UPDATE impersonation_sessions SET mode = 'write', write_confirmed_at = now() WHERE id = $1`, [impersonationId]);
  } else {
    await sql(`INSERT INTO service_engagements (tenant_id, service) VALUES ($1, 'catalog_management') ON CONFLICT DO NOTHING`, [shop.tenant.id]);
    [{ id: serviceSessionId }] = await sql(`INSERT INTO service_sessions (tenant_id, operator_id, service, task_ref) VALUES ($1, $2, 'catalog_management', 'TASK-9') RETURNING id`, [shop.tenant.id, operator.id]);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await sql(`INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at, fresh_until, impersonation_id, service_session_id) VALUES ($1, $2, $3, 'cookie', now() + interval '30 minutes', now() + interval '10 minutes', $4, $5)`,
    [hashSessionToken(token), shop.tenant.id, owner.id, impersonationId, serviceSessionId]);
  const cookie = `sid=${token}`;
  const me = await hit(w.app, '/api/v1/auth/me', { host: shop.host, cookie });
  const csrf = me.status === 200 ? me.json().csrf : '';
  return async (method, path, body) => {
    const res = await hit(w.app, `/api/v1${path}`, { host: shop.host, cookie, method, body, headers: { 'x-csrf-token': csrf } });
    return { status: res.status, code: res.text ? JSON.parse(res.text).code : null };
  };
}

const ROUTES = [['GET', '/billing'], ['GET', '/billing/catalog'], ['POST', '/billing/change', { plan: 't2', requestKey: 'rk-operator-0001' }], ['POST', '/billing/items', { code: 'whatsapp', requestKey: 'rk-operator-0002' }],
  ['DELETE', '/billing/items/1'], ['GET', '/billing/invoices'], ['GET', '/billing/invoices/1/file'], ['GET', '/billing/statements'], ['POST', '/billing/payment-method']];

test('owner only, fresh for money, and closed to impersonation and service operators', async (t) => {
  const w = await openBilling(t);
  const shop = await w.business({ state: '29' });
  await shop.subscribe('t1');

  // Signed out, and a staff member with every permission.
  assert.equal((await hit(w.app, '/api/v1/billing', { host: shop.host })).status, 401);
  const staff = await addStaff(w.app, shop, { permissions: ['catalog', 'orders', 'automations', 'analytics', 'customers', 'inbox'] });
  for (const [method, path, body] of ROUTES) {
    const res = await shop.api(method, path, body, { token: staff.token });
    assert.equal(res.status, 403, `${method} ${path} for staff`);
  }

  // A session whose last sign-in or re-auth is not recent may read but not change money.
  const [{ id: sessionId }] = await w.sql(`SELECT id FROM sessions WHERE id = $1`, [hashSessionToken(shop.token)]);
  await w.sql(`UPDATE sessions SET fresh_until = now() - interval '1 minute' WHERE id = $1`, [sessionId]);
  assert.equal((await shop.api('GET', '/billing')).status, 200);
  for (const [method, path, body] of [['POST', '/billing/change', { plan: 't2', requestKey: shop.key() }], ['POST', '/billing/items', item('whatsapp')], ['DELETE', '/billing/items/1'], ['POST', '/billing/payment-method']]) {
    const res = await shop.api(method, path, body);
    assert.deepEqual([res.status, res.json.code], [403, 'reauth_required'], `${method} ${path}`);
  }
  assert.equal((await shop.tenantRow()).plan, 't1');

  for (const kind of ['impersonation', 'service']) {
    const call = await operatorSession(w, shop, { kind });
    for (const [method, path, body] of ROUTES) {
      const res = await call(method, path, body);
      assert.equal(res.status, 403, `${kind}: ${method} ${path}`);
      assert.ok(['impersonation.blocked', 'service.out_of_scope'].includes(res.code), `${kind}: ${method} ${path} answered ${res.code}`);
    }
  }
  assert.equal((await w.sql('SELECT 1 FROM subscription_items WHERE tenant_id = $1', [shop.tenant.id])).length, 0, 'nothing was bought by anyone else');
});

test('one business never sees or reaches another’s billing; a webhook naming two businesses is ignored and flagged', async (t) => {
  const w = await openBilling(t);
  const a = await w.business({ state: '29' });
  const b = await w.business({ state: '29' });
  await a.subscribe('t1');
  const [invoice] = await a.invoices();
  assert.deepEqual((await b.api('GET', '/billing/invoices')).json.items, []);
  assert.equal((await b.api('GET', `/billing/invoices/${invoice.id}/file`)).status, 404);
  assert.equal((await b.api('GET', '/billing')).json.plan, 'free');

  // The file: a link that lasts minutes, for the owner of the business it belongs to.
  const link = await a.api('GET', `/billing/invoices/${invoice.id}/file`);
  assert.equal(link.status, 200, link.text);
  assert.ok(new Date(link.json.expiresAt) - Date.now() <= 5 * 60_000 + 1000);
  const pdf = await hit(w.app, link.json.fileUrl, { host: a.host, token: a.token });
  assert.equal(pdf.status, 200, pdf.text.slice(0, 200));
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.raw.subarray(0, 4).toString(), '%PDF');
  assert.ok((await a.invoices())[0].file_key.startsWith(`t/${a.tenant.id}/billing/`));
  assert.equal((await hit(w.app, link.json.fileUrl.replace(/sig=[^&]+/, 'sig=forged'), { host: a.host, token: a.token })).status, 403);
  assert.equal((await hit(w.app, link.json.fileUrl, { host: a.host })).status, 401);
  assert.equal((await hit(w.app, link.json.fileUrl, { host: b.host, token: b.token })).status, 403, 'another business’s owner, on its own address');

  // A charge for A's subscription whose notes name B.
  const s = await a.sub();
  const res = await w.rzp.post('/webhooks/send', {
    accountId: 'billing', event: 'subscription.charged',
    payload: { subscription: { entity: { id: s.provider_subscription_id, status: 'active', notes: { tenant: String(b.tenant.id) } } }, payment: { entity: { id: 'pay_mismatch1', amount: 100, status: 'captured' } } },
  });
  assert.equal(res.status, 200);
  await w.settle();
  const event = (await w.events()).at(-1);
  assert.deepEqual([event.status, event.outcome, event.security], ['ignored', 'tenant_mismatch', true]);
  assert.equal((await a.payments()).length, 1);
  assert.equal((await b.payments()).length, 0);
});
