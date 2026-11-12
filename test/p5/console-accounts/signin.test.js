// The console's sign-in helpers (console/src/features/account/signin.js) against the contract they copy: the browser cannot
// import src/contracts/accounts.js (it needs node:crypto), so every number and pattern it repeats is held equal here, and the
// helpers that build what the server reads are checked with the server's own schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import * as accounts from '../../../src/contracts/accounts.js';
import { AUTH_PATHS, DeviceInput, GoogleStartQuery } from '../../../src/contracts/api/index.js';
import * as signin from '../../../console/src/features/account/signin.js';

const memory = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
};
const refusing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

test('the copied numbers and patterns are the contract\'s own', () => {
  assert.equal(signin.CODE_DIGITS, accounts.CODE_RULES.digits);
  assert.equal(signin.DEVICE_ID.source, accounts.DEVICE_ID.source);
  assert.equal(signin.PKCE_VERIFIER.source, accounts.PKCE_VERIFIER.source);
  assert.equal(signin.PKCE_CHALLENGE.source, accounts.PKCE_CHALLENGE.source);
  assert.equal(signin.GOOGLE_START, AUTH_PATHS.googleStart);
  // The page to open after Google: the same paths pass here as pass the server's query schema.
  const serverTakes = (next) => GoogleStartQuery.safeParse({ next }).success;
  for (const next of ['/admin', '/admin/orders/12?tab=1', '//evil.example', 'https://evil.example', '/admin/<b>', '/a b', '/admin#x', '']) {
    assert.equal(signin.NEXT_PATH.test(next) && next.length <= 500, serverTakes(next), next);
  }
  fc.assert(fc.property(fc.string({ maxLength: 40 }).map((s) => `/${s}`), (next) => (signin.NEXT_PATH.test(next) && next.length <= 500) === serverTakes(next)));
});

test('a number is read and masked exactly as the server reads and masks it', () => {
  const samples = ['9876543210', '09876543210', '919876543210', '+919876543210', '0044 20 7946 0958', '+1 (415) 555-0100', '12345', '', '  98765 43210 ', '5876543210', 'abc', '+0123456789'];
  for (const value of samples) {
    assert.equal(signin.toE164(value), accounts.toE164(value), value);
    assert.equal(signin.maskPhone(signin.toE164(value) ?? ''), accounts.maskPhone(accounts.toE164(value) ?? ''), value);
  }
  fc.assert(fc.property(fc.string({ maxLength: 24 }), (value) => signin.toE164(value) === accounts.toE164(value)));
  fc.assert(fc.property(fc.stringMatching(/^[6-9]\d{9}$/), (local) => signin.maskOwnPhone(local) === accounts.maskPhone(`+91${local}`)));
  assert.equal(signin.maskOwnPhone(''), '');
});

test('a code is six digits and nothing else', () => {
  assert.equal(signin.isCode('123456'), true);
  for (const bad of ['12345', '1234567', '12345a', ' 123456', '', null, undefined]) assert.equal(signin.isCode(bad), false, String(bad));
});

test('this browser\'s device: one id kept across sign-ins, a name from the user agent, and a shape the server accepts', () => {
  const storage = memory();
  const first = signin.deviceId(storage);
  assert.match(first, accounts.DEVICE_ID);
  assert.equal(signin.deviceId(storage), first, 'the same browser keeps its id');
  assert.notEqual(signin.deviceId(memory()), first, 'another browser gets another');
  storage.setItem('bhava.device', 'short');
  assert.notEqual(signin.deviceId(storage), 'short', 'a kept value the server would refuse is replaced');
  assert.match(signin.deviceId(refusing), accounts.DEVICE_ID, 'a private window still signs in, with an id for this page');
  assert.match(signin.deviceId(null), accounts.DEVICE_ID);

  const names = {
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36': 'Chrome on Android',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1': 'Safari on iPhone',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0': 'Edge on Windows',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0': 'Firefox on Mac',
    '': 'Web browser',
  };
  for (const [agent, name] of Object.entries(names)) assert.equal(signin.deviceName(agent), name);

  const device = signin.webDevice({ storage, userAgent: Object.keys(names)[0] });
  const parsed = DeviceInput.safeParse(device);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data, { ...device, app: 'owner', appVersion: '' });
  assert.equal(parsed.data.platform, 'web');
});

test('a PKCE pair for linking Google: the verifier and challenge the server checks, made with the page\'s own crypto', async () => {
  for (let i = 0; i < 20; i++) {
    const { verifier, challenge } = await signin.pkcePair(crypto.webcrypto);
    assert.match(verifier, accounts.PKCE_VERIFIER);
    assert.match(challenge, accounts.PKCE_CHALLENGE);
    assert.equal(challenge, accounts.pkceChallenge(verifier));
    assert.ok(accounts.pkceMatches(verifier, challenge));
  }
  await assert.rejects(() => signin.pkcePair({ getRandomValues: () => {} }), /secure connection/);
});

test('Continue with Google sends the page to open afterwards only when it is a plain path here', () => {
  const read = (url) => {
    const [path, search] = url.split('?');
    assert.equal(path, AUTH_PATHS.googleStart);
    const parsed = GoogleStartQuery.safeParse(Object.fromEntries(new URLSearchParams(search)));
    assert.ok(parsed.success, `${url}: ${JSON.stringify(parsed.error?.issues)}`);
    return parsed.data;
  };
  assert.deepEqual(read(signin.googleStartUrl({ next: '/admin/orders/12?tab=items' })), { target: 'web', purpose: 'signin', next: '/admin/orders/12?tab=items' });
  for (const bad of ['//evil.example/admin', 'https://evil.example/', '/admin/<script>', '/admin/ snap', `/admin/${'x'.repeat(600)}`, '']) {
    assert.equal(read(signin.googleStartUrl({ next: bad })).next, '/admin', bad);
  }
  const challenge = accounts.pkceChallenge('v'.repeat(43));
  assert.deepEqual(read(signin.googleStartUrl({ purpose: 'link', challenge, next: '/admin/settings/account' })), { target: 'web', purpose: 'link', challenge, next: '/admin/settings/account' });
});

test('freshness: a session that said when its check ends, with a margin; one that never said is tried as it is', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(signin.isFresh(new Date(now + 60_000).toISOString(), now), true);
  assert.equal(signin.isFresh(new Date(now + 10_000).toISOString(), now), false, 'inside the margin is not fresh');
  assert.equal(signin.isFresh(new Date(now - 1).toISOString(), now), false);
  assert.equal(signin.isFresh(null, now), false);
  assert.equal(signin.isFresh('not a date', now), false);
  assert.equal(signin.isFresh(undefined, now), null);
});

test('a deletion\'s timeline is kept for the next sign-in page, and only a whole one is read back', () => {
  const storage = memory();
  assert.equal(signin.readDeletion(storage), null);
  signin.keepDeletion(storage, { status: 'requested', requestedAt: '2026-11-12T10:00:00.000Z', dueAt: '2026-12-12T10:00:00.000Z' });
  assert.deepEqual(signin.readDeletion(storage), { requestedAt: '2026-11-12T10:00:00.000Z', dueAt: '2026-12-12T10:00:00.000Z' });
  signin.clearDeletion(storage);
  assert.equal(signin.readDeletion(storage), null);
  storage.setItem('bhava.deletion', '{"requestedAt":1}');
  assert.equal(signin.readDeletion(storage), null);
  storage.setItem('bhava.deletion', 'not json');
  assert.equal(signin.readDeletion(storage), null);
  assert.equal(signin.readDeletion(refusing), null);
  assert.doesNotThrow(() => signin.keepDeletion(refusing, { requestedAt: 'a', dueAt: 'b' }));
});

test('"Send a new code" wakes after the server\'s resend time', () => {
  const sent = 1_000_000;
  assert.equal(signin.secondsLeft(sent, 30, sent), 30);
  assert.equal(signin.secondsLeft(sent, 30, sent + 29_001), 1);
  assert.equal(signin.secondsLeft(sent, 30, sent + 30_000), 0);
  assert.equal(signin.secondsLeft(sent, 30, sent + 90_000), 0);
  assert.equal(accounts.CODE_RULES.resendAfterMs, 30_000);
});
