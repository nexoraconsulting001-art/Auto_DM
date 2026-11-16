// auth-8 (PRD 5.5): the Platform Console's per-address failure limit. In production the cache is Redis, where a get and a
// set are two round trips; counting there by read-then-write loses failures that arrive together. The limit is counted
// in Postgres in one statement instead, and a successful sign-in does not wipe the address's count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformAuth } from '../../../src/auth.js';
import { createRateLimit } from '../../../src/platform/rate-limit.js';
import { openTestDb } from '../../helpers.js';

/** A cache whose every call waits a little, the way a network round trip to Redis does. */
function slowCache() {
  const map = new Map();
  const wait = () => new Promise((r) => setTimeout(r, 10));
  return {
    async get(key) { await wait(); return map.get(key) ?? null; },
    async set(key, value) { await wait(); map.set(key, structuredClone(value)); },
    async del(key) { await wait(); map.delete(key); },
  };
}

async function limiterWorld(t) {
  const db = await openTestDb();
  t.after(() => db.close().catch(() => {}));
  const platformUsers = { createSession: async () => 'session-token', userForSession: async () => null, revokeSession: async () => {} };
  const auth = createPlatformAuth({ secret: 'x'.repeat(32), platformUsers, cache: slowCache(), rateLimit: createRateLimit({ db }) });
  return { auth };
}

const fakeReq = (ip) => ({ ip, secure: false, get: () => undefined, headers: {} });
const fakeRes = () => ({ cookie() {}, clearCookie() {} });

test('auth-8: failures that arrive together are all counted, so the address is stopped', async (t) => {
  const { auth } = await limiterWorld(t);
  const req = fakeReq('203.0.113.77');
  await Promise.all(Array.from({ length: 12 }, () => auth.recordFailure(req)));
  assert.equal(await auth.tooManyAttempts(req), true, 'failures recorded at the same moment were lost');
  assert.equal(await auth.tooManyAttempts(fakeReq('203.0.113.78')), false, 'another address is not affected');
});

test('auth-8: a successful sign-in from the address does not wipe its failures', async (t) => {
  const { auth } = await limiterWorld(t);
  const req = fakeReq('203.0.113.79');
  for (let i = 0; i < 9; i++) await auth.recordFailure(req);
  assert.equal(await auth.tooManyAttempts(req), false);
  await auth.login(req, fakeRes(), { id: 1 });
  await auth.recordFailure(req);
  assert.equal(await auth.tooManyAttempts(req), true);
});
