// tenancy-2: a request switched into another business with X-Tenant-Id runs as that business in full, verified primary
// domain included, so the store links a seller copies are the same as when signed in there directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REEL_ID } from '../../helpers.js';
import { addBusiness, addStaff, api, need, nextPhone, startWorld } from '../../p0/spec-p0/support.js';

test('tenancy-2: switching into a business with a verified primary domain gives its store links on that domain', async (t) => {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  await app.platform.tenants.addDomain(b.tenant.id, 'shop.beta-brand.example');
  await app.db.platform.query(`UPDATE tenant_domains SET status = 'verified', is_primary = true WHERE tenant_id = $1 AND domain = 'shop.beta-brand.example'`, [b.tenant.id]);
  const product = await b.repos.products.create({ name: 'Brass lamp', price: '499', active: 'on' });
  await b.repos.reels.save(REEL_ID, { headline: 'Lamp edit', keywords: 'LINK', productIds: [product.id], active: 'on' });

  const phone = nextPhone();
  const inA = await addStaff(app, a, { permissions: ['automations'], phone });
  const inB = await addStaff(app, b, { permissions: ['automations'], phone });

  const direct = need(await api(app, b, inB.token, '/reels'), 200, 'reels at B, signed in there').json();
  assert.equal(new URL(direct.items[0].storeUrl).host, 'shop.beta-brand.example', 'signed in at B, links are on B\'s own domain');

  const switched = need(await api(app, a, inA.token, '/reels', { headers: { 'x-tenant-id': String(b.tenant.id) } }), 200, 'reels at B, switched from A').json();
  assert.equal(switched.items[0].storeUrl, direct.items[0].storeUrl, 'switched in, the seller copies the same link');
  const one = need(await api(app, a, inA.token, `/reels/${REEL_ID}`, { headers: { 'x-tenant-id': String(b.tenant.id) } }), 200, 'one reel at B, switched').json();
  assert.equal(new URL(one.storeUrl).host, 'shop.beta-brand.example');
});
