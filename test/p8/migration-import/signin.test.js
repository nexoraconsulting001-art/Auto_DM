// F-72: a migrated shopper signs in with a WhatsApp code on the same phone and sees their old orders, and nobody else's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMigration } from '../../../src/modules/migration/index.js';
import { browser, placeOrder, signInWithCode, world as shopperWorld } from '../../p4/shoppers/support.js';
import { legacyExport } from './support.js';

test('F-72: a migrated shopper logs in by OTP on the same phone and sees their old orders, and nobody else’s', async () => {
  const w = await shopperWorld({ google: false });
  try {
    const { app } = w;
    const source = await legacyExport({ phones: ['9000000201', '9000000202'] });
    const report = await createMigration({ db: app.db, platform: app.ctx.platform }).run(source, { tenantId: app.tenant.id }, { reason: 'Moving the old shop onto the platform' });
    assert.equal(report.blocked, false);
    // Another business has an order on the same number: it never shows here.
    const other = await w.addStore('second', 'Second shop');
    await placeOrder(app.db, other.tenant.id, { phone: '+919000000201', number: 'SEC-1' });

    const b = browser(app);
    await signInWithCode(w, b, '9000000201');
    const page = await (await b.request('/account/orders')).text();
    for (const mine of ['OLH-4208', 'OLH-4210']) assert.ok(page.includes(mine), `${mine} is theirs`);
    for (const theirs of ['OLH-4209', 'OLH-4100', 'SEC-1']) assert.ok(!page.includes(theirs), `${theirs} is not`);
    const detail = await b.request('/account/orders/OLH-4210');
    assert.equal(detail.status, 200);
    assert.equal((await b.request('/account/orders/OLH-4209')).status, 404, 'another migrated shopper’s order stays theirs');

    const [shopper] = await app.db.platform.query(`SELECT phone_verified_at FROM shoppers WHERE tenant_id = $1 AND phone = '+919000000201'`, [app.tenant.id]);
    assert.ok(shopper.phone_verified_at, 'the code proved the number, so the old account is theirs now');

    const other2 = browser(app);
    await signInWithCode(w, other2, '9000000202');
    const second = await (await other2.request('/account/orders')).text();
    assert.ok(second.includes('OLH-4209') && !second.includes('OLH-4210'));
  } finally {
    await w.close();
  }
});
