// Platform roles live apart from business roles (PRD 5.11): only a super admin can export the raw event log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSOLE_HOST, addBusiness, consoleUser, hit, onConsole, signIn, startWorld } from '../../p0/spec-p0/support.js';

test('F-111: a support role or a business owner asking for a raw event log export gets 403; only a super admin can export', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'mehta-mart', name: 'Mehta Mart' });
  const body = { reason: 'Audit', tables: ['audit_log'], tenantIds: [shop.tenant.id], from: '2026-01-01', to: '2027-01-01' };
  const exports = async () => (await app.db.platform.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'raw_export.create'`))[0].n;

  const support = await consoleUser(app, 'support');
  const refused = await onConsole(app, support, '/raw-export', { method: 'POST', body });
  assert.equal(refused.status, 403);

  // A business owner has no platform session at all: their token is no key to the platform host.
  const token = await signIn(app, shop);
  const owner = await hit(app, '/raw-export', { host: CONSOLE_HOST, method: 'POST', token, body });
  assert.ok([401, 403].includes(owner.status), `got ${owner.status}`);
  const onShop = await hit(app, '/api/v1/raw-export', { host: shop.host, method: 'POST', token, body });
  assert.ok([403, 404].includes(onShop.status), 'and the business API has no such route');
  assert.equal(await exports(), 0);

  const root = await consoleUser(app, 'super_admin');
  const made = await onConsole(app, root, '/raw-export', { method: 'POST', body });
  assert.equal(made.status, 201);
  assert.equal(await exports(), 1);
});
