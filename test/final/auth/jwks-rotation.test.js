// F-109 (PRD 10.3): a sign-in token signed with a key the issuer no longer publishes signs nobody in. Before, the key
// set was kept for an hour and only fetched again for a key id it had not seen, so a withdrawn key went on verifying
// until the hour was up. Now the set is trusted for minRefetchMs (60 s by default) after it was fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createKeySet } from '../../../src/adapters/oidc.js';

const jwk = (kid) => ({ ...crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });

function issuer() {
  let published = [jwk('k1')];
  let down = false;
  let fetches = 0;
  return {
    rotate: () => { published = [jwk(`k${Date.now()}${crypto.randomInt(1e6)}`)]; },
    set down(value) { down = value; },
    get fetches() { return fetches; },
    fetch: async () => {
      fetches++;
      if (down) throw new Error('unreachable');
      return new Response(JSON.stringify({ keys: published }), { status: 200 });
    },
  };
}

test('a withdrawn key stops verifying once minRefetchMs has passed, without waiting an hour', async () => {
  let clock = 1_000_000;
  const apple = issuer();
  const keys = createKeySet({ url: 'https://keys.example/auth/keys', fetch: apple.fetch, now: () => clock });
  assert.ok(await keys.key('k1'), 'the published key');
  apple.rotate();
  clock += 30_000;
  assert.ok(await keys.key('k1'), 'inside the minute the set is not fetched again for a known key');
  clock += 31_000;
  assert.equal(await keys.key('k1'), null, 'a minute later the withdrawn key is gone');
});

test('while the issuer is down the last set still verifies, and it is asked again on the next use', async () => {
  let clock = 1_000_000;
  const apple = issuer();
  const keys = createKeySet({ url: 'https://keys.example/auth/keys', fetch: apple.fetch, now: () => clock });
  assert.ok(await keys.key('k1'));
  apple.down = true;
  clock += 61_000;
  const before = apple.fetches;
  assert.ok(await keys.key('k1'), 'the last set verifies while the issuer is unreachable');
  assert.equal(apple.fetches, before + 1, 'the set was asked for again');
});

test('a longer cacheMs can still be chosen explicitly', async () => {
  let clock = 1_000_000;
  const apple = issuer();
  const keys = createKeySet({ url: 'https://keys.example/auth/keys', fetch: apple.fetch, now: () => clock, cacheMs: 3_600_000 });
  assert.ok(await keys.key('k1'));
  apple.rotate();
  clock += 120_000;
  assert.ok(await keys.key('k1'), 'kept for the cacheMs it was given');
});
