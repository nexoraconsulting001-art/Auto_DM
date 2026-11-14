// PRD 5.6 and 5.17: the pure parts of onboarding and managed services, without a server. Active time is never more than the
// clock (F-31); an undo writes back exactly the fields the team changed, never a masked secret (F-95); the operator's
// one-time address cannot be forged or moved to another business; the invite token is stored only as a hash (F-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASKED, maskSecrets } from '../../../src/contracts/services.js';
import { activeTimes } from '../../../src/modules/onboarding/console.js';
import { stateCodeOf } from '../../../src/modules/onboarding/checklist.js';
import { hashInviteToken, inviteStateOf, newInviteToken } from '../../../src/modules/onboarding/invites.js';
import { entryToken, readEntryToken } from '../../../src/modules/managed-services/entry.js';
import { undoInput } from '../../../src/modules/managed-services/feed.js';
import { withTenant } from '../../../src/tenancy.js';

const at = (min) => new Date(Date.UTC(2026, 10, 1, 10, 0) + min * 60_000).toISOString();
const row = (step, a, b, activeMs = (b - a) * 60_000) => ({ step, active_ms: activeMs, started_at: at(a), ended_at: at(b) });

test('F-31: active time is capped at each span, the same minutes twice count once, and the total is the sum of the steps', () => {
  const plain = activeTimes([row('form', 0, 3), row('brand_read', 4, 6), row('import', 20, 22), row('review', 22, 23), row('invite', 23, 24)]);
  assert.equal(plain.activeMs, 9 * 60_000);
  assert.deepEqual(plain.timings.map((t) => t.step), ['form', 'brand_read', 'import', 'review', 'invite']);
  // An hour claimed for one minute on the clock is one minute.
  assert.equal(activeTimes([row('form', 0, 1, 3_600_000)]).activeMs, 60_000);
  // The same three minutes reported twice, and an overlapping minute, are still three minutes.
  assert.equal(activeTimes([row('form', 0, 3), row('form', 0, 3), row('form', 1, 2)]).activeMs, 3 * 60_000);
  // Two separate spans add up; a wait between them does not count.
  assert.equal(activeTimes([row('import', 0, 2), row('import', 30, 31)]).activeMs, 3 * 60_000);
  // Less active time than the span is what is counted.
  assert.equal(activeTimes([row('review', 0, 10, 60_000)]).activeMs, 60_000);
  // An unknown step is not counted.
  assert.equal(activeTimes([row('coffee', 0, 10)]).activeMs, 0);
});

test('F-95: an undo writes back the fields the change set, at their old values, and a reel order as the order it was', () => {
  const change = { request: { params: { id: 4 }, body: { pricePaise: 59_900 } }, before: { id: 4, name: 'Lamp', pricePaise: 49_900 }, after: { id: 4, name: 'Lamp', pricePaise: 59_900 } };
  assert.deepEqual(undoInput(change, 'products.update'), { pricePaise: 49_900 });
  assert.equal(undoInput({ ...change, before: null }, 'products.update'), null, 'nothing to write back for a creation');
  assert.equal(undoInput({ ...change, request: { params: {}, body: {} } }, 'products.update'), null);
  const sequence = {
    categoryId: 7,
    items: [
      { pageId: 3, pinned: false, pinPosition: null, position: 2 },
      { pageId: 1, pinned: true, pinPosition: 1, position: 0 },
      { pageId: 9, pinned: true, pinPosition: 0, position: 1 },
      { pageId: 5, pinned: false, pinPosition: null, position: 1 },
    ],
  };
  assert.deepEqual(undoInput({ request: { params: { id: 7 }, body: { pageId: 3 } }, before: sequence, after: sequence }, 'categories.setReels'), { pinned: [9, 1], order: [5, 3] });
  assert.equal(undoInput({ request: {}, before: { items: 'x' } }, 'categories.setReels'), null);
});

test('F-90: a recorded before and after never hold a secret, at any depth', () => {
  const masked = maskSecrets({ name: 'x', keySecret: 's3cr3t', nested: [{ accessToken: 'abc', ok: 1 }], password: '', authorization: 'Bearer z' });
  assert.equal(JSON.stringify(masked).includes('s3cr3t'), false);
  assert.equal(JSON.stringify(masked).includes('Bearer z'), false);
  assert.equal(masked.nested[0].accessToken, MASKED);
  assert.equal(masked.nested[0].ok, 1);
});

test('F-27: an invite token is long and random, only its hash is stored, and its state reads expired, used and revoked', () => {
  const a = newInviteToken();
  const b = newInviteToken();
  assert.notEqual(a, b);
  assert.match(a, /^[\w-]{40,}$/);
  const hash = hashInviteToken(a);
  assert.notEqual(hash, a);
  assert.equal(hash.includes(a), false);
  assert.equal(hashInviteToken(a), hash, 'the same token hashes the same way');
  assert.notEqual(hashInviteToken(a.toUpperCase()), hash);
  const future = new Date(Date.now() + 86_400_000);
  assert.equal(inviteStateOf(null), 'none');
  assert.equal(inviteStateOf({ expires_at: future }), 'sent');
  assert.equal(inviteStateOf({ expires_at: new Date(Date.now() - 1000) }), 'expired');
  assert.equal(inviteStateOf({ expires_at: future, used_at: new Date() }), 'used');
  assert.equal(inviteStateOf({ expires_at: future, revoked_at: new Date() }), 'revoked');
});

test('F-91: the operator\'s one-time address is signed for one business and one session, and cannot be altered or reused elsewhere', () => {
  const config = { sessionSecret: 'unit-secret' };
  const token = withTenant(12, () => entryToken(config, 34));
  assert.deepEqual(readEntryToken(config, token), { tenantId: 12, sessionId: 34 });
  assert.equal(readEntryToken({ sessionSecret: 'other' }, token), null, 'another server\'s secret');
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), t: 13 })).toString('base64url');
  assert.equal(readEntryToken(config, `${forged}.${mac}`), null, 'another business');
  assert.equal(readEntryToken(config, `${payload}.${mac.slice(0, -2)}xx`), null);
  assert.equal(readEntryToken(config, ''), null);
  assert.equal(readEntryToken(config, 'a.b.c'), null);
  const stale = Buffer.from(JSON.stringify({ t: 12, s: 34, e: Date.now() - 1, n: 'x' })).toString('base64url');
  assert.equal(readEntryToken(config, `${stale}.${mac}`), null);
});

test('F-80: a pickup address names its state, which is kept as the state code', () => {
  assert.equal(stateCodeOf('Maharashtra'), '27');
  assert.equal(stateCodeOf('  maharashtra '), '27');
  assert.equal(stateCodeOf('Jammu & Kashmir'), '01');
  assert.equal(stateCodeOf('Narnia'), null);
  assert.equal(stateCodeOf(''), null);
});
