// Seller sign-in with a WhatsApp code (PRD 5.11, 10.3): the code's rules under attack, the same answer for every
// number, the limits, the platform's own number, the first business of someone new, and the review login.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_LIMITS, CODE_RULES, codeHash } from '../../../src/contracts/accounts.js';
import { withTenant } from '../../../src/tenancy.js';
import { APP_HOST, OWNER, accountsApp, call, captureLogs, codeSignIn, freshIp, random10, sellerCodeFor, sentCount, testDevice, typedAccount } from './support.js';

let app;
before(async () => {
  app = await accountsApp();
});
after(() => app?.close());

const start = (phone, ip = freshIp(), extra = {}) => call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip, ...extra });
const verify = (phone, code, ip = freshIp(), extra = {}) => call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone, code, ...extra }, ip });
const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

test('F-117: a login code arrives on WhatsApp from the platform\'s own number by the login_code template, and there is no SMS', async () => {
  const before = await sentCount(app.whatsapp);
  const res = await start(OWNER.phone);
  assert.equal(res.status, 202);
  assert.deepEqual(Object.keys(res.json).sort(), ['alternatives', 'channel', 'expiresInSeconds', 'resendInSeconds', 'sent']);
  assert.equal(res.json.channel, 'whatsapp');
  assert.equal(res.json.expiresInSeconds, 300);
  const { sent } = await app.whatsapp.get('/sent');
  assert.equal(sent.length, before + 1);
  const message = sent.at(-1);
  assert.equal(message.phoneId, '1000', 'from the platform number');
  assert.equal(message.body.type, 'template');
  assert.equal(message.body.template.name, 'login_code');
  assert.match(await sellerCodeFor(app.whatsapp, OWNER.phone), /^\d{6}$/);
  // The code is in no table: only keyed hashes are.
  const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
  const rows = await app.db.platform.query('SELECT subject_hash, code_hash FROM seller_login_codes');
  for (const row of rows) {
    assert.equal(JSON.stringify(row).includes(code), false);
    assert.equal(JSON.stringify(row).includes(OWNER.phone), false);
  }
});

test('a code signs in once: the second use of the same code is refused', async () => {
  const ip = freshIp();
  const phone = random10();
  assert.equal((await start(phone, ip)).status, 202);
  const code = await sellerCodeFor(app.whatsapp, phone);
  const first = await verify(phone, code, ip, { device: testDevice() });
  assert.equal(first.status, 201);
  const again = await verify(phone, code, ip);
  assert.deepEqual([again.status, again.json.code], [401, 'unauthorized']);
});

test('a code dies after 5 minutes', async () => {
  const phone = random10();
  await start(phone);
  const code = await sellerCodeFor(app.whatsapp, phone);
  await app.db.platform.query(`UPDATE seller_login_codes SET expires_at = now() - interval '1 second', created_at = created_at - interval '301 seconds' WHERE expires_at > now()`);
  assert.equal((await verify(phone, code)).status, 401);
  assert.equal(CODE_RULES.ttlMs, 300_000);
});

test('a code dies after 5 wrong tries, even racing, and the right one is refused after that', async () => {
  const phone = random10();
  await start(phone);
  const code = await sellerCodeFor(app.whatsapp, phone);
  const tries = await Promise.all(Array.from({ length: 8 }, () => verify(phone, wrongCode(code))));
  assert.ok(tries.every((t) => t.status === 401 || t.status === 429));
  const [row] = await app.db.platform.query('SELECT attempts FROM seller_login_codes ORDER BY id DESC LIMIT 1');
  assert.equal(row.attempts, 5, 'the database stops at the fifth');
  assert.equal((await verify(phone, code)).status, 401, 'the right code no longer works');
});

test('a new code replaces the one before, and a resend inside 30 s sends nothing and answers the same', async () => {
  const phone = random10();
  const first = await start(phone);
  const firstCode = await sellerCodeFor(app.whatsapp, phone);
  const count = await sentCount(app.whatsapp);
  const again = await start(phone);
  assert.deepEqual(again.json, first.json, 'the same answer');
  assert.equal(await sentCount(app.whatsapp), count, 'nothing sent inside the resend window');
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await start(phone);
  const secondCode = await sellerCodeFor(app.whatsapp, phone);
  assert.equal(await sentCount(app.whatsapp), count + 1);
  if (secondCode !== firstCode) assert.equal((await verify(phone, firstCode)).status, 401, 'the older code stopped working');
  assert.equal((await verify(phone, secondCode)).status, 201);
});

test('a known and an unknown number get the same answer, do the same work and take about the same time', async () => {
  const known = [];
  const unknown = [];
  for (let i = 0; i < 6; i++) {
    const phone = random10();
    await typedAccount(app, app.tenant, { phone, role: 'staff', permissions: ['orders'] });
    known.push(phone);
    unknown.push(random10());
  }
  const timed = async (phone) => {
    const sent = await sentCount(app.whatsapp);
    const t0 = performance.now();
    const res = await start(phone);
    const ms = performance.now() - t0;
    return { res, ms, sentOne: (await sentCount(app.whatsapp)) === sent + 1 };
  };
  const knownRuns = [];
  const unknownRuns = [];
  for (let i = 0; i < known.length; i++) {
    knownRuns.push(await timed(known[i]));
    unknownRuns.push(await timed(unknown[i]));
  }
  for (const run of [...knownRuns, ...unknownRuns]) {
    assert.equal(run.res.status, 202);
    assert.deepEqual(run.res.json, knownRuns[0].res.json);
    assert.equal(run.sentOne, true, 'a code goes out either way');
  }
  const median = (runs) => runs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const [a, b] = [median(knownRuns), median(unknownRuns)];
  assert.ok(Math.abs(a - b) < Math.max(40, 0.75 * Math.max(a, b)), `known ${a.toFixed(1)} ms, unknown ${b.toFixed(1)} ms`);

  // A wrong code is the same refusal for both.
  const refusedKnown = await verify(known[0], '000000');
  const refusedUnknown = await verify(unknown[0], '000000');
  const refusedJunk = await verify('not a phone', ['x']);
  for (const refused of [refusedKnown, refusedUnknown, refusedJunk]) {
    assert.equal(refused.status, 401);
    assert.equal(refused.json.error, refusedKnown.json.error);
    assert.equal(refused.json.code, 'unauthorized');
  }
});

test('F-118: a phone with no WhatsApp gets the same answer, which offers Google sign-in', async () => {
  await app.whatsapp.fault({ kind: 'rate_limit', status: 400, body: { error: { message: 'Undeliverable', code: 131026 } } });
  const res = await start(random10());
  assert.equal(res.status, 202);
  assert.equal(res.json.sent, true);
  assert.ok(res.json.alternatives.includes('google'));
  assert.equal(res.json.alternatives.includes('sms'), false);
});

test('the code is never logged, nor the number, on any path', async () => {
  const phone = random10();
  let code;
  const lines = await captureLogs(async () => {
    const ip = freshIp();
    await start(phone, ip);
    code = await sellerCodeFor(app.whatsapp, phone);
    await verify(phone, wrongCode(code), ip);
    await verify(phone, code, ip);
    await verify(phone, code, ip);
  });
  assert.ok(lines.length > 0);
  const all = lines.join('\n');
  assert.equal(all.includes(code), false, 'no code in the logs');
  assert.equal(all.includes(phone), false, 'no number in the logs');
  assert.equal(all.includes(phone.slice(-6)), false);
});

test('sends are limited per number and per address, in the database, whether or not the number has an account', async () => {
  // Per number: five codes an hour, from any address.
  const phone = random10();
  for (let i = 0; i < AUTH_LIMITS.codeSendsPerNumber.limit; i++) {
    assert.equal((await start(phone)).status, 202);
    await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  }
  const over = await start(phone);
  assert.deepEqual([over.status, over.json.code], [429, 'rate_limited']);
  const ownerOver = await (async () => {
    for (let i = 0; i < AUTH_LIMITS.codeSendsPerNumber.limit + 1; i++) {
      const res = await start(OWNER.phone);
      await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
      if (res.status === 429) return res;
    }
    return null;
  })();
  assert.deepEqual([ownerOver?.status, ownerOver?.json.code, ownerOver?.json.error], [429, 'rate_limited', over.json.error], 'the same for a number with an account');

  // Per address: twenty an hour, whichever numbers.
  const ip = freshIp();
  for (let i = 0; i < AUTH_LIMITS.codeSendsPerAddress.limit; i++) assert.equal((await start(random10(), ip)).status, 202);
  assert.equal((await start(random10(), ip)).status, 429);
  // The count is a row in the database, so another process sees it: only a hash of the subject is kept.
  const rows = await app.db.platform.query('SELECT key FROM rate_limit_hits');
  assert.ok(rows.length > 0);
  assert.equal(rows.some((r) => r.key.includes(phone) || r.key.includes(ip)), false);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
});

test('tries are limited per number across addresses, so many codes cannot be guessed at from many places', async () => {
  const phone = random10();
  await start(phone);
  const code = await sellerCodeFor(app.whatsapp, phone);
  let refusedAt = null;
  for (let i = 0; i < AUTH_LIMITS.codeTriesPerNumber.limit + 1; i++) {
    const res = await verify(phone, '000000' === code ? '111111' : '000000');
    if (res.status === 429) {
      refusedAt = i;
      break;
    }
  }
  assert.equal(refusedAt, AUTH_LIMITS.codeTriesPerNumber.limit);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
});

test('a verified number ties the seller accounts with that number; signing in opens the one used last and lists the rest', async () => {
  const session = await codeSignIn(app, { device: testDevice() });
  assert.equal(session.user.phone, OWNER.phone);
  assert.equal(session.user.role, 'owner');
  assert.equal(session.business.id, app.tenant.id);
  assert.equal(session.created, false);
  assert.ok(session.accessToken && session.refreshToken);
  assert.equal(session.accessExpiresInSeconds, 15 * 60);
  assert.ok(Date.parse(session.freshUntil) > Date.now());
  const [owner] = await withTenant(app.tenant, () => app.db.query('SELECT person_id FROM users WHERE tenant_id = $1 AND id = $2', [app.tenant.id, app.ownerId]));
  assert.ok(owner.person_id, 'the account now belongs to the person who proved the number');
  const me = await call(app, '/api/v1/auth/me', { headers: session.auth });
  assert.deepEqual([me.status, me.json.user.id], [200, app.ownerId]);
});

test('P-69: someone with no seller account anywhere gets a Free creator business and the same app', async () => {
  const phone = random10();
  const session = await codeSignIn(app, { phone, device: testDevice('Moto G') });
  assert.equal(session.created, true);
  assert.equal(session.business.accountType, 'creator');
  assert.equal(session.business.plan, 'free');
  assert.equal(session.user.role, 'owner');
  assert.notEqual(session.business.id, app.tenant.id);
  assert.deepEqual(session.businesses.map((b) => b.id), [session.business.id]);
  // The same app's routes work for the creator, in their own business only.
  const orders = await call(app, '/api/v1/orders', { headers: session.auth });
  assert.equal(orders.status, 200);
  assert.deepEqual(orders.json.items, []);
  // Signing in again opens the same business, not another new one.
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  const again = await codeSignIn(app, { phone });
  assert.deepEqual([again.created, again.business.id], [false, session.business.id]);
});

test('on a business\'s own address the session opens there, and a person with no account there is refused', async () => {
  const session = await codeSignIn(app, { host: null });
  assert.equal(session.business.id, app.tenant.id);
  const stranger = random10();
  const ip = freshIp();
  await start(stranger, ip, { host: null });
  const code = await sellerCodeFor(app.whatsapp, stranger);
  const refused = await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone: stranger, code }, ip, host: null });
  assert.equal(refused.status, 403);
  const made = await app.db.platform.query('SELECT 1 FROM users WHERE phone = $1', [stranger]);
  assert.deepEqual(made, [], 'no business is made for them there');
});

test('the console signs in with a cookie on the sign-in host: same origin only, and CSRF on every change after', async () => {
  const session = await codeSignIn(app, { transport: 'cookie' });
  assert.ok(session.cookie?.startsWith('sid='));
  assert.ok(session.csrf);
  assert.equal(session.accessToken, undefined);
  const me = await call(app, '/api/v1/auth/me', { headers: { cookie: session.cookie } });
  assert.equal(me.status, 200);
  assert.equal((await call(app, '/api/v1/settings', { method: 'PATCH', headers: { cookie: session.cookie }, body: {} })).status, 403, 'no CSRF token');

  const phone = random10();
  const ip = freshIp();
  await start(phone, ip);
  const code = await sellerCodeFor(app.whatsapp, phone);
  const elsewhere = await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone, code, transport: 'cookie' }, ip, headers: { origin: 'https://evil.example' } });
  assert.equal(elsewhere.status, 403, 'a sign-in posted from another site opens nothing');
  assert.equal(elsewhere.headers.get('set-cookie'), null);
});

test('P-11: the sign-in screen offers Google and a WhatsApp code, never a password or SMS', async () => {
  const res = await call(app, '/api/v1/app/requirements?platform=android');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json.signIn).sort(), ['apple', 'google', 'whatsapp']);
  assert.equal(res.json.signIn.whatsapp, true);
  assert.equal(res.json.signIn.apple, false, 'Apple is offered on iOS only');
  const page = await call(app, '/signin');
  assert.equal(page.status, 200);
  assert.match(page.text, /WhatsApp/);
  assert.match(page.text, /Bhava/);
  assert.equal(/type="password"|password/i.test(page.text), false, 'no password field');
  assert.equal(/\bSMS\b/.test(page.text), false, 'no SMS');
  assert.equal((await call(app, '/signin', { host: null })).text.includes('Send code on WhatsApp'), false, 'the page lives on the sign-in host only');
});

test('with PASSWORD_LOGIN off, password login answers 404 on every host', async () => {
  const off = await accountsApp({ overrides: { passwordLogin: false } });
  try {
    for (const host of [APP_HOST, null]) {
      const res = await call(off, '/api/v1/auth/login', { method: 'POST', body: { phone: OWNER.phone, password: OWNER.password }, host });
      assert.deepEqual([res.status, res.json.code], [404, 'not_found']);
    }
    // And signing in with a code still works.
    const session = await codeSignIn(off);
    assert.equal(session.business.id, off.tenant.id);
  } finally {
    await off.close();
  }
});

// The review login (F-50, P-24): its own app, with the review number and the hash of its code configured.
const REVIEW_PHONE = '+919000000099';
const REVIEW_CODE = '424242';
let reviewWorld = null;
async function review() {
  reviewWorld ??= (async () => {
    const hash = codeHash('test-secret', { purpose: 'signin', subject: REVIEW_PHONE, code: REVIEW_CODE });
    const world = await accountsApp({ overrides: { reviewLoginPhone: REVIEW_PHONE, reviewLoginCodeHash: hash } });
    const demo = await world.platform.tenants.create({ slug: 'demo-review', name: 'Demo Store' });
    await withTenant(demo, () => world.platform.products.create({ name: 'Sample kurta', price: '499', active: 'on' }));
    const uses = () => world.db.platform.query('SELECT accepted, reason FROM review_login_uses ORDER BY id');
    const tryIt = (phone, code) => call(world, '/api/v1/auth/verify', { method: 'POST', body: { phone, code, device: testDevice('Review iPad') }, ip: freshIp() });
    // Before the demo business is named the login opens nothing.
    assert.equal((await tryIt('9000000099', REVIEW_CODE)).status, 401);
    await world.db.platform.query('UPDATE review_logins SET tenant_id = $1', [demo.id]);
    return { world, demo, uses, tryIt };
  })();
  return reviewWorld;
}
after(async () => (await reviewWorld)?.world.close());

test('F-50: the review code on another number is rejected and logged, and so is every other try on the review number', async () => {
  const { uses, tryIt, world } = await review();
  const other = await tryIt('9876543210', REVIEW_CODE);
  assert.deepEqual([other.status, other.json.code], [401, 'unauthorized']);
  assert.deepEqual((await uses()).at(-1), { accepted: false, reason: 'wrong_number' });
  assert.equal(other.json.error, (await tryIt('9876500000', '000000')).json.error, 'refused like any wrong code');
  assert.equal((await tryIt('9000000099', '111111')).status, 401);
  assert.deepEqual((await uses()).at(-1), { accepted: false, reason: 'wrong_code' });
  const stored = JSON.stringify(await world.db.platform.query('SELECT * FROM review_login_uses'));
  assert.equal(stored.includes('9000000099') || stored.includes(REVIEW_CODE), false, 'no number or code in the log rows');
});

test('P-24: the review login opens the demo business with its sample data, only with the review flag on', async () => {
  const { uses, tryIt, demo, world } = await review();
  const ok = await tryIt('9000000099', REVIEW_CODE);
  assert.equal(ok.status, 201);
  assert.equal(ok.json.business.id, demo.id);
  assert.deepEqual(ok.json.businesses.map((b) => b.id), [demo.id], 'the demo business only');
  assert.deepEqual((await uses()).at(-1), { accepted: true, reason: '' });
  const products = await call(world, '/api/v1/products', { headers: { authorization: `Bearer ${ok.json.accessToken}` } });
  assert.equal(products.status, 200);
  assert.equal(products.json.items.length, 1);
  // With the flag off it is an ordinary wrong code.
  await world.db.platform.query('UPDATE review_logins SET enabled = false');
  assert.equal((await tryIt('9000000099', REVIEW_CODE)).status, 401);
  assert.deepEqual((await uses()).at(-1), { accepted: false, reason: 'flag_off' });
  await world.db.platform.query('UPDATE review_logins SET enabled = true');
});

test('the shared helpers sign in through these routes: signIn for the console, appSession for the app', async () => {
  const { signIn, appSession } = await import('../../helpers.js');
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
  const web = await signIn(app.base, { phone: OWNER.phone, whatsapp: app.whatsapp });
  assert.ok(web.cookie && web.csrf);
  assert.equal((await fetch(`${app.base}/api/v1/auth/me`, { headers: web.headers })).status, 200);
  const mobile = await appSession(app.base, { phone: OWNER.phone, whatsapp: app.whatsapp, app: { version: '1.0.0' } });
  assert.ok(mobile.accessToken && mobile.refreshToken);
  const orders = await fetch(`${app.base}/api/v1/orders`, { headers: mobile.headers });
  assert.equal(orders.status, 200);
  const devices = await (await fetch(`${app.base}/api/v1/auth/devices`, { headers: mobile.headers })).json();
  assert.equal(devices.devices.find((d) => d.current)?.name, mobile.device.name);
});
