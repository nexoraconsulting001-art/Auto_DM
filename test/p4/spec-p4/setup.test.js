// The store is set up the way an owner sets it up: through the console, with the providers answering. Every other Phase 4
// spec builds on this; where a step had to be written straight to the tables instead, this file says which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addP4Shop, useP4World } from './kit.js';

const world = useP4World();

test('S-19: a business is made ready to sell through the console alone (WhatsApp, managed payments with KYC, pickup, consent notice)', async () => {
  const shop = await addP4Shop(world);
  assert.deepEqual(shop.shortcuts, [], 'Setup steps the console refused, so the specs wrote the rows directly');
  const account = await shop.must('GET', '/payment-account', undefined, 200, 'Reading the payment account');
  assert.equal(account.mode, 'managed');
  assert.equal(account.kycStatus, 'verified');
  const options = await shop.must('GET', '/payment-settings', undefined, 200, 'Reading payment options');
  assert.equal(options.onlineReady, true, 'Online payment is on once KYC has passed');
});
