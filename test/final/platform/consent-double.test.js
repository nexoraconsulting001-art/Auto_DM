// D-9: the Phase 2 spec world stands in for shopper consent (PRD 9.18). Since Phase 4 the consent module registers its provider in
// setup(ctx) unless platform.consent is already built, so a stand-in must be a registered provider behind the real interface
// (src/platform/consent.js): built true, every provider method present, and every question still asked inside a business.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withTenant } from '../../../src/tenancy.js';
import { addP2Shop, openP2World } from '../../p2/spec-p2/support.js';

test('D-9: the Phase 2 world opens, and its consent stand-in is a registered provider behind the real interface', async (t) => {
  const world = await openP2World();
  t.after(() => world.close());
  const shop = await addP2Shop(world);
  const consent = world.webDrivers.consent;
  assert.equal(consent.built, true, 'the stand-in counts as a registered provider, so the consent module does not register over it');
  assert.throws(() => consent.use({}), /already registered/, 'it went through use(), not a look-alike object');
  // The interface still refuses to answer outside a business.
  await assert.rejects(consent.allows({ purpose: 'analytics_ads', visitorId: 'v1' }), /tenant|business/i);
  await withTenant(shop.tenant, async () => {
    assert.deepEqual(await consent.analyticsAndAds({ visitorId: 'v1' }), { granted: false, answered: false, reason: 'spec.unanswered' });
    world.consent.grant();
    assert.equal((await consent.analyticsAndAds({ visitorId: 'v1' })).granted, true, 'what a test tells the stand-in is what the app hears');
    // Other purposes come from what was recorded, per business, never assumed.
    assert.equal((await consent.allows({ purpose: 'marketing', channel: 'email', email: 'a@mail.example' })).granted, false);
    const notice = await consent.notice();
    await consent.record({ subject: { email: 'a@mail.example' }, choices: [{ purpose: 'marketing', channel: 'email', granted: true }], noticeVersion: notice.version, source: 'checkout' });
    assert.equal((await consent.allows({ purpose: 'marketing', channel: 'email', email: 'a@mail.example' })).granted, true);
    await consent.revoke({ subject: { email: 'a@mail.example' }, purpose: 'marketing', channel: 'email', source: 'unsubscribe' });
    assert.equal((await consent.allows({ purpose: 'marketing', channel: 'email', email: 'a@mail.example' })).granted, false);
  });
  const other = await addP2Shop(world);
  await withTenant(other.tenant, async () => {
    await withTenant(shop.tenant, () => consent.record({ subject: { email: 'b@mail.example' }, choices: [{ purpose: 'marketing', channel: 'email', granted: true }], noticeVersion: 1, source: 'checkout' }));
    assert.equal((await consent.allows({ purpose: 'marketing', channel: 'email', email: 'b@mail.example' })).granted, false, 'a yes at one business never counts at another');
  });
});
