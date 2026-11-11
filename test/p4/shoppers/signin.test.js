// Shopper sign-in (PRD 9.3): WhatsApp codes, Google, and shopper sessions that never reach a seller's actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogSink } from '../../../src/platform/log.js';
import { OWNER } from '../../helpers.js';
import { browser, signInWithCode, world } from './support.js';

const defaultSink = (line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
const PHONE = '9876543210';

test('S-07: the right WhatsApp code within 5 minutes signs the shopper in and sends them back to checkout', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    const sent = await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' } });
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { sent: true, expiresInSeconds: 300 });
    const code = await w.lastCode(PHONE);
    assert.match(code, /^[0-9]{6}$/);

    const res = await b.request('/api/store/otp/verify?next=%2Fcheckout', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.signedIn, true);
    // Back to checkout: the bag lives in the browser, so nothing here touches it.
    assert.equal(body.next, '/checkout');
    assert.ok(b.cookies().get('_sid'), 'the shopper cookie is set');
    assert.equal(b.cookies().get('sid'), undefined, 'and never the seller cookie');

    const account = await b.request('/account');
    assert.equal(account.status, 200);
    assert.match(await account.text(), /Signed in as \+91 ••••• ••210/);

    // The code is used up: the same code again does nothing.
    const again = await browser(w.app).request('/api/store/otp/verify', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code } });
    assert.equal(again.status, 400);
  } finally {
    await w.close();
  }
});

test('S-08: three wrong codes kill the code, and a new one must be asked for', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' } });
    const code = await w.lastCode(PHONE);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      const res = await b.request('/api/store/otp/verify', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code: wrong } });
      assert.equal(res.status, 400);
      if (i === 2) assert.match((await res.json()).error, /too many times\. Ask for a new one/);
    }
    const right = await b.request('/api/store/otp/verify', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code } });
    assert.equal(right.status, 400, 'the right code no longer works');
    assert.equal(b.cookies().get('_sid'), undefined);

    await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' } });
    const fresh = await w.lastCode(PHONE);
    assert.equal((await b.request('/api/store/otp/verify', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code: fresh } })).status, 200);
  } finally {
    await w.close();
  }
});

test('S-09: the sixth code in an hour is refused with a wait message and nothing is sent', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    for (let i = 0; i < 5; i++) assert.equal((await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' } })).status, 200);
    const before = await w.sentCount();
    const sixth = await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' } });
    assert.equal(sixth.status, 429);
    const body = await sixth.json();
    assert.equal(body.code, 'rate_limited');
    assert.match(body.error, /Try again in \d+ minutes/);
    assert.ok(Number(sixth.headers.get('retry-after')) > 0);
    assert.equal(await w.sentCount(), before, 'no WhatsApp message went out');
    // Another number is its own count.
    assert.equal((await b.request('/api/store/otp/send', { method: 'POST', json: { phone: '9811111111', purpose: 'sign_in' } })).status, 200);
  } finally {
    await w.close();
  }
});

test('one-time codes: only a hash is stored, a newer code replaces the older, an expired one fails, sends are limited per address, and neither the code nor the number is logged', async () => {
  const lines = [];
  setLogSink((line) => lines.push(line));
  const w = await world();
  try {
    const b = browser(w.app);
    await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' } });
    const first = await w.lastCode(PHONE);
    const rows = await w.app.db.platform.query('SELECT code_hash, phone_hash FROM shopper_otps');
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(first) && !JSON.stringify(rows).includes(PHONE), 'no code or number in the table');

    await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' } });
    const second = await w.lastCode(PHONE);
    if (first !== second) assert.equal((await b.request('/api/store/otp/verify', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code: first } })).status, 400, 'the older code is replaced');

    await w.app.db.platform.query(`UPDATE shopper_otps SET expires_at = now() - interval '1 second'`);
    assert.equal((await b.request('/api/store/otp/verify', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code: second } })).status, 400, 'an expired code fails');

    // Twenty sends an hour from one address, across numbers.
    const limits = [];
    for (let i = 0; i < 19; i++) limits.push((await b.request('/api/store/otp/send', { method: 'POST', json: { phone: `98${String(10000000 + i)}`, purpose: 'sign_in' } })).status);
    assert.ok(limits.includes(429), 'the per-address limit stops a flood of numbers');

    const all = lines.join('\n');
    assert.match(all, /shopper\.otp_sent/);
    for (const secret of [first, second, PHONE, `91${PHONE}`]) assert.ok(!all.includes(secret), `the log holds no ${secret.length}-digit secret`);
  } finally {
    setLogSink(defaultSink);
    await w.close();
  }
});

test('a code request from another site is refused, and a malformed one is a 400', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    const evil = await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in' }, headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal((await b.request('/api/store/otp/send', { method: 'POST', json: { phone: { $gt: '' }, purpose: 'sign_in' } })).status, 400);
    assert.equal((await b.request('/api/store/otp/send', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', price: 1 } })).status, 400);
    assert.equal((await b.request('/api/store/otp/verify', { method: 'POST', json: { phone: PHONE, purpose: 'sign_in', code: '12' } })).status, 400);
    assert.equal(await w.sentCount(), 0);
  } finally {
    await w.close();
  }
});

test('S-10: inside Instagram’s in-app browser the WhatsApp code comes first, and there is no SMS option anywhere', async () => {
  const w = await world();
  try {
    const inApp = browser(w.app, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Instagram 312.0.0.0' });
    const page = await (await inApp.request('/login?next=/checkout')).text();
    assert.ok(page.indexOf('Send code on WhatsApp') > 0);
    assert.ok(page.indexOf('Send code on WhatsApp') < page.indexOf('Continue with Google'), 'WhatsApp is offered first');
    assert.match(page, /create an account to place your order/);
    assert.doesNotMatch(page, /\bSMS\b/i);

    const chrome = await (await browser(w.app).request('/login')).text();
    assert.ok(chrome.indexOf('Continue with Google') < chrome.indexOf('Send code on WhatsApp'), 'in Chrome, Google comes first');
    assert.doesNotMatch(chrome, /\bSMS\b/i);
    assert.doesNotMatch(chrome, /bhava/i, 'the sign-in page carries the seller’s brand only');
  } finally {
    await w.close();
  }
});

test('S-92: Google sign-in in Chrome asks for no code', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    await w.google.post('/next-user', { sub: 'g-123', email: 'asha@example.com', email_verified: true, name: 'Asha Kulkarni' });
    const start = await b.request('/auth/google?next=/checkout');
    assert.equal(start.status, 302);
    const toGoogle = new URL(start.headers.get('location'));
    assert.equal(toGoogle.origin, w.google.url);
    assert.equal(toGoogle.searchParams.get('redirect_uri'), `${w.app.base}/auth/google/callback`);
    const back = await fetch(toGoogle, { redirect: 'manual' });
    assert.equal(back.status, 302);
    const callback = new URL(back.headers.get('location'));
    const done = await b.request(`${callback.pathname}${callback.search}`);
    assert.equal(done.status, 303);
    assert.equal(done.headers.get('location'), '/checkout');
    assert.ok(b.cookies().get('_sid'));
    assert.equal(await w.sentCount(), 0, 'no WhatsApp code was sent');
    const [shopper] = await w.app.db.platform.query('SELECT google_sub, email, name, phone FROM shoppers');
    assert.deepEqual(shopper, { google_sub: 'g-123', email: 'asha@example.com', name: 'Asha Kulkarni', phone: null });

    // A callback with someone else's state, or without this browser's cookie, signs nobody in.
    const stranger = browser(w.app);
    const refused = await stranger.request(`${callback.pathname}${callback.search}`);
    assert.equal(refused.status, 303);
    assert.equal(refused.headers.get('location'), '/login?next=%2Fcheckout&problem=expired', 'back to sign-in, so no page is drawn at an address holding the code');
    assert.equal(stranger.cookies().get('_sid'), undefined);
  } finally {
    await w.close();
  }
});

test('S-11: the same phone at two stores is two accounts, and one store’s orders never show at the other', async () => {
  const w = await world();
  try {
    const leaf = await w.addStore('leaf', 'Leaf and Clay');
    const atA = browser(w.app);
    const atB = browser(w.app, { host: leaf.host });
    await signInWithCode(w, atA, PHONE);
    await signInWithCode(w, atB, PHONE);
    const rows = await w.app.db.platform.query('SELECT id, tenant_id, phone FROM shoppers ORDER BY id');
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].tenant_id, rows[1].tenant_id);
    const { placeOrder } = await import('./support.js');
    await placeOrder(w.app.db, w.app.tenant.id, { shopperId: rows[0].id, number: 'A-1001' });
    assert.match(await (await atA.request('/account/orders')).text(), /A-1001/);
    assert.doesNotMatch(await (await atB.request('/account/orders')).text(), /A-1001/);
    assert.equal((await atB.request('/account/orders/A-1001')).status, 404);
    // A's cookie means nothing on B's address.
    const crossed = browser(w.app, { host: leaf.host });
    crossed.cookies(leaf.host).set('_sid', atA.cookies().get('_sid'));
    assert.equal((await crossed.request('/account')).status, 302);
  } finally {
    await w.close();
  }
});

test('a shopper session never reaches a seller: not the seller API, not the console, not even on the owner’s own number', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    // The owner's number, verified by code, is still only a shopper.
    await signInWithCode(w, b, OWNER.phone);
    assert.ok(b.cookies().get('_sid'));
    for (const path of ['/api/v1/products', '/api/v1/settings', '/api/v1/auth/me', '/api/v1/shoppers', '/api/v1/audit-log']) {
      const res = await b.request(path);
      assert.ok([401, 403].includes(res.status), `${path} answered ${res.status}`);
    }
    const write = await b.request('/api/v1/products', { method: 'POST', json: { name: 'x', price: 1 } });
    assert.ok([401, 403].includes(write.status));
    const login = await b.request('/login');
    assert.equal(login.status, 302, 'a signed-in shopper is sent on, never to the console');
    assert.notEqual(login.headers.get('location'), '/admin');

    // A shopper's POST needs the session's CSRF token.
    const noToken = await b.request('/api/store/addresses', { method: 'POST', json: { name: 'Asha K', phone: PHONE, line1: '12 MG Road', city: 'Pune', stateCode: '27', pincode: '411001' } });
    assert.equal(noToken.status, 403);
  } finally {
    await w.close();
  }
});

test('signing out ends the shopper session on the server', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    const { csrf } = await signInWithCode(w, b, PHONE);
    const token = b.cookies().get('_sid');
    const out = await b.request('/logout', { method: 'POST', form: { _shopper_csrf: csrf } });
    assert.equal(out.status, 303);
    const replay = browser(w.app);
    replay.cookies().set('_sid', token);
    assert.equal((await replay.request('/account')).status, 302, 'the old token no longer signs anyone in');
  } finally {
    await w.close();
  }
});
