// PRD 5.11 and 5.13: sellers sign in with a WhatsApp code from Bhava's own number, never SMS and never a password, and
// App Review's fixed code works only for the review number with the flag on. F-117, F-118, F-50, P-11 (the server's half).
// Codes are read from what the WhatsApp simulator received, as the seller's phone would show them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_LIMITS, AUTH_PATHS, CODE_RULES, CODE_TABLES, PLATFORM_PHONE_ID, REVIEW, SECOND, addSeller, appSignIn, atOnce, captureLogs, codeIn, digitsOf,
  local10, newDevice, newSellerPhone, noCrash, ownerPhone, randomIp, refusedWith, startCode, useP5World, verifyCode, wrongCode,
} from './kit.js';

const world = useP5World();

/** Asks for a code for `phone` and reads it from Bhava's WhatsApp number. */
async function codeFor(phone, { ip = randomIp() } = {}) {
  const seen = (await world.sellerMessages(phone)).length;
  const res = await startCode(world, phone, { ip });
  assert.equal(res.status, 202, `Asking for a code: ${res.status} ${res.text.slice(0, 200)}`);
  const code = await world.sellerCode(phone, { after: seen });
  assert.ok(code, 'No code arrived on WhatsApp from Bhava\'s number');
  return { code, res };
}

const NO_SMS = /\bsms\b|text message|password/i;

test('F-117: a login code arrives on WhatsApp from Bhava\'s verified number as an approved template, and nothing goes by SMS', async (t) => {
  const logs = captureLogs(t);
  const shop = await addSeller(world, { name: 'Copper Kettle' });
  const phone = ownerPhone(shop);
  const before = (await world.allMessagesTo(phone)).length;
  const { code, res } = await codeFor(phone);

  assert.deepEqual([res.data.sent, res.data.channel], [true, 'whatsapp']);
  assert.equal(res.data.expiresInSeconds, CODE_RULES.ttlMs / 1000, 'A code lives five minutes');
  assert.ok(res.data.resendInSeconds > 0 && res.data.resendInSeconds <= CODE_RULES.resendAfterMs / 1000, 'The resend button waits');
  assert.ok(res.data.alternatives.every((a) => ['google', 'apple'].includes(a)), `Alternatives: ${res.data.alternatives}`);
  assert.doesNotMatch(res.text, NO_SMS, 'The answer mentions SMS or a password');

  const messages = (await world.allMessagesTo(phone)).slice(before);
  assert.equal(messages.length, 1, `${messages.length} messages reached the number for one request`);
  const [message] = messages;
  assert.equal(message.phoneId, PLATFORM_PHONE_ID, 'The code did not come from Bhava\'s own WhatsApp number');
  assert.equal(message.type, 'template', 'A login code goes as an approved template, not free text');
  assert.ok(message.body?.template?.name, 'The template has no name');
  assert.equal(codeIn(message), code);
  assert.match(code, /^\d{6}$/);
  assert.doesNotMatch(JSON.stringify(message.body), /Copper Kettle/, 'A seller\'s login code carries the business\'s name instead of Bhava\'s');

  // Neither the code nor the number is kept in the clear or logged.
  const rows = await world.sql('SELECT * FROM seller_login_codes ORDER BY id DESC LIMIT 5');
  assert.ok(rows.length >= 1, 'No seller_login_codes row');
  assert.ok(!JSON.stringify(rows).includes(code), 'The code is stored as sent');
  assert.ok(!JSON.stringify(rows).includes(local10(phone)), 'The number is stored in the clear');
  assert.ok(!logs.text().includes(code), 'The code is in the logs');
  assert.ok(!logs.text().includes(local10(phone)), 'The number is in the logs');

  // It signs the owner in, into their own business.
  const signed = await verifyCode(world, { phone, code, device: newDevice() });
  assert.equal(signed.status, 201, `The right code: ${signed.status} ${signed.text.slice(0, 200)}`);
  assert.equal(signed.data.business.id, shop.tenantId);
  assert.equal(signed.data.user.role, 'owner');
  assert.ok(signed.data.accessToken && signed.data.refreshToken, 'The app gets an access token and a refresh token');
  assert.ok(!logs.text().includes(signed.data.refreshToken), 'The refresh token is in the logs');
});

test('F-117: an unknown number gets exactly the answer a known one gets', async () => {
  const shop = await addSeller(world);
  const known = await startCode(world, ownerPhone(shop));
  const unknown = await startCode(world, newSellerPhone());
  assert.equal(known.status, 202);
  assert.equal(unknown.status, known.status, 'The status says whether the number has an account');
  assert.deepEqual(Object.keys(unknown.data ?? {}).sort(), Object.keys(known.data ?? {}).sort());
  assert.deepEqual({ ...unknown.data, requestId: undefined }, { ...known.data, requestId: undefined }, 'The answer says whether the number has an account');
  // Junk is answered like any number, never as a validation error that says which part was wrong.
  for (const phone of ['', 'abc', '12', '+0000', '9'.repeat(40), '98765 43210\u0000']) {
    const res = noCrash(await startCode(world, phone), `auth.start with ${JSON.stringify(phone)}`);
    assert.ok([202, 429].includes(res.status), `auth.start with ${JSON.stringify(phone)} answered ${res.status}: ${res.text.slice(0, 200)}`);
  }
});

test('F-118: a number WhatsApp cannot deliver to is offered Google sign-in, with no SMS fallback', async () => {
  const phone = newSellerPhone();
  await world.wa.post('/faults', {
    kind: 'rate_limit', status: 400, times: 3, match: { method: 'POST', path: `*/${PLATFORM_PHONE_ID}/messages`, body: { to: digitsOf(phone) } },
    body: { error: { message: '(#131026) Message undeliverable', type: 'OAuthException', code: 131026, fbtrace_id: 'spec' } },
  });
  const res = noCrash(await startCode(world, phone), 'Asking for a code for a number with no WhatsApp');
  assert.ok(res.status < 500);
  assert.ok((res.data?.alternatives ?? []).includes('google'), `Google is not offered: ${res.text.slice(0, 300)}`);
  assert.doesNotMatch(res.text, NO_SMS, 'An SMS fallback is offered');
  // Nothing else went to the number by any other way, and asking again sends no SMS either.
  await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
  noCrash(await startCode(world, phone), 'Asking again');
  const calls = (await world.wa.get('/calls')).calls ?? [];
  assert.ok(calls.every((c) => !/sms/i.test(JSON.stringify(c.body ?? {}))), 'Something asked WhatsApp for an SMS');
  await world.wa.delete('/faults');
});

test('F-118: when Bhava\'s WhatsApp provider is down the answer offers Google and is never a fault', async () => {
  const phone = newSellerPhone();
  for (const fault of [{ kind: 'server_error' }, { kind: 'timeout', delayMs: 3000 }, { kind: 'malformed', mode: 'garbage' }]) {
    await world.wa.post('/faults', { ...fault, times: 2, match: { method: 'POST', path: `*/${PLATFORM_PHONE_ID}/messages` } });
    const res = noCrash(await startCode(world, phone), `auth.start with WhatsApp ${fault.kind}`);
    assert.ok((res.data?.alternatives ?? []).includes('google') || /google/i.test(res.text), `${fault.kind}: Google is not offered: ${res.text.slice(0, 200)}`);
    assert.doesNotMatch(res.text, NO_SMS);
    await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
    await world.wa.delete('/faults');
  }
});

test('F-117: a code works once, for five minutes, for the number it was sent to and nothing else', async () => {
  const shop = await addSeller(world);
  const phone = ownerPhone(shop);

  // Used twice: the second time, from another device, is refused.
  const first = await codeFor(phone);
  assert.equal((await verifyCode(world, { phone, code: first.code, device: newDevice() })).status, 201);
  const replay = await verifyCode(world, { phone, code: first.code, device: newDevice('Thief phone') });
  refusedWith(replay, [400, 401, 403], 'The same code a second time');
  assert.equal(replay.data?.accessToken, undefined);

  // A code for one number, on another.
  await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
  const other = newSellerPhone();
  const mine = await codeFor(phone);
  refusedWith(await verifyCode(world, { phone: other, code: mine.code }), [400, 401, 403], 'A code sent to one number, typed with another');
  // The same number written another way is the same number.
  assert.equal((await verifyCode(world, { phone: `0${local10(phone)}`, code: mine.code, device: newDevice() })).status, 201, 'The number with a leading 0 is the same number');

  // Inside five minutes it works; just past, it does not.
  await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
  const late = await codeFor(phone);
  await world.shift(CODE_RULES.ttlMs - 30 * SECOND, ['seller_login_codes']);
  assert.equal((await verifyCode(world, { phone, code: late.code, device: newDevice() })).status, 201, 'A code at four and a half minutes');
  await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
  const expired = await codeFor(phone);
  await world.shift(CODE_RULES.ttlMs + SECOND, ['seller_login_codes']);
  refusedWith(await verifyCode(world, { phone, code: expired.code }), [400, 401, 403], 'A code a second past five minutes');
});

test('F-117: five wrong tries end a code, and the right one after them is refused', async () => {
  const phone = ownerPhone(await addSeller(world));
  const { code } = await codeFor(phone);
  const ip = randomIp();
  const answers = [];
  for (let i = 0; i < CODE_RULES.maxAttempts; i++) answers.push(await verifyCode(world, { phone, code: wrongCode(code) }, { ip }));
  for (const res of answers) refusedWith(res, [400, 401, 403, 429], 'A wrong code');
  refusedWith(await verifyCode(world, { phone, code }, { ip: randomIp() }), [400, 401, 403, 429], 'The right code after five wrong ones');
  const rows = await world.sql('SELECT attempts FROM seller_login_codes WHERE used_at IS NULL ORDER BY id DESC LIMIT 1');
  assert.ok(rows.length === 0 || rows[0].attempts <= CODE_RULES.maxAttempts);
  // Bad input is a wrong code: the same answer, never a validation error that says which part was wrong.
  const fresh = newSellerPhone();
  await startCode(world, fresh);
  const wrong = await verifyCode(world, { phone: fresh, code: '000000' });
  for (const body of [{ phone: fresh, code: 'abcdef' }, { phone: fresh, code: ['123456'] }, { phone: 12345, code: '123456' }, { phone: fresh, code: '1'.repeat(500) }, { phone: '<script>', code: '123456' }]) {
    const res = noCrash(await verifyCode(world, body, { ip: randomIp() }), `auth.verify with ${JSON.stringify(body).slice(0, 60)}`);
    assert.equal(res.status, wrong.status, `${JSON.stringify(body).slice(0, 60)} is answered unlike a wrong code`);
  }
});

test('F-117: guessing is limited per number and per address, whether or not the number has an account', async () => {
  // Per number: across fresh codes, at most codeTriesPerNumber tries in the window.
  for (const phone of [ownerPhone(await addSeller(world)), newSellerPhone()]) {
    let limited = null;
    for (let i = 0; i < AUTH_LIMITS.codeTriesPerNumber.limit + 6 && !limited; i++) {
      if (i % CODE_RULES.maxAttempts === 0) {
        await world.shift(CODE_RULES.resendAfterMs + SECOND, ['seller_login_codes']);
        await startCode(world, phone);
      }
      const res = noCrash(await verifyCode(world, { phone, code: String(100000 + i) }, { ip: randomIp() }), 'A guess');
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, `${AUTH_LIMITS.codeTriesPerNumber.limit + 6} guesses at one number were never limited`);
    assert.equal(limited.data?.code, 'rate_limited');
  }
  // Per address: guesses at many numbers from one address.
  const ip = randomIp();
  let limited = null;
  for (let i = 0; i < AUTH_LIMITS.codeTriesPerAddress.limit + 5 && !limited; i++) {
    const res = noCrash(await verifyCode(world, { phone: newSellerPhone(), code: '123456' }, { ip }), 'A guess');
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, `${AUTH_LIMITS.codeTriesPerAddress.limit + 5} guesses from one address were never limited`);
  assert.equal(limited.data?.code, 'rate_limited');
});

test('F-117: a resend flood sends one code per window and at most five an hour, to any number', async () => {
  const shop = await addSeller(world);
  for (const phone of [ownerPhone(shop), newSellerPhone()]) {
    const seen = (await world.sellerMessages(phone)).length;
    const burst = await atOnce(8, () => startCode(world, phone, { ip: randomIp() }));
    for (const res of burst) noCrash(res, 'A resend inside the window');
    await world.sellerCode(phone, { after: seen, ms: 1500 });
    const inWindow = (await world.sellerMessages(phone)).length - seen;
    assert.ok(inWindow <= 1, `${inWindow} codes went out for 8 taps inside the resend window`);

    let limited = null;
    for (let i = 0; i < AUTH_LIMITS.codeSendsPerNumber.limit + 2 && !limited; i++) {
      await world.shift(CODE_RULES.resendAfterMs + SECOND, ['seller_login_codes']);
      const res = noCrash(await startCode(world, phone, { ip: randomIp() }), 'A resend');
      if (res.status === 429) limited = res;
    }
    const sent = (await world.sellerMessages(phone)).length - seen;
    assert.ok(sent <= AUTH_LIMITS.codeSendsPerNumber.limit, `${sent} codes went to one number inside an hour`);
    assert.ok(limited, 'Resends were never limited');
    assert.equal(limited.data?.code, 'rate_limited');
  }
});

test('F-117: one address asking for codes for many numbers is limited', async () => {
  const ip = randomIp();
  let limited = null;
  let sent = 0;
  for (let i = 0; i < AUTH_LIMITS.codeSendsPerAddress.limit + 3 && !limited; i++) {
    const res = noCrash(await startCode(world, newSellerPhone(), { ip }), 'A code for another number');
    if (res.status === 429) limited = res;
    else sent += 1;
  }
  assert.ok(limited, `${AUTH_LIMITS.codeSendsPerAddress.limit + 3} numbers from one address were never limited`);
  assert.ok(sent <= AUTH_LIMITS.codeSendsPerAddress.limit);
  assert.equal(limited.data?.code, 'rate_limited');
});

test('F-117: two verifies of the right code at once open one session', async () => {
  const phone = ownerPhone(await addSeller(world));
  const { code } = await codeFor(phone);
  const answers = await atOnce(5, () => verifyCode(world, { phone, code, device: newDevice() }));
  const opened = answers.filter((r) => r.status === 201);
  assert.equal(opened.length, 1, `${opened.length} sessions from one code: ${answers.map((r) => r.status)}`);
  for (const r of answers.filter((x) => x.status !== 201)) refusedWith(r, [400, 401, 403, 409, 429], 'The losing verify');
});

test('F-117: a sign-in code cannot be used to re-authenticate, nor a re-auth code to sign in', async () => {
  const phone = ownerPhone(await addSeller(world));
  const s = await appSignIn(world, phone);
  // A sign-in code asked for now, presented as a re-auth.
  await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
  const { code } = await codeFor(phone);
  refusedWith(await s.send('POST', '/auth/reauth/verify', { code }), [400, 401, 403], 'A sign-in code used to re-authenticate');
  // A re-auth code, presented as a sign-in.
  await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
  const seen = (await world.sellerMessages(phone)).length;
  assert.equal((await s.send('POST', '/auth/reauth/start')).status, 202);
  const reauth = await world.sellerCode(phone, { after: seen });
  assert.ok(reauth, 'No re-auth code arrived');
  refusedWith(await verifyCode(world, { phone, code: reauth }), [400, 401, 403], 'A re-auth code used to sign in');
});

test('F-50: the review code on another number is rejected, and the try is logged without the number', async () => {
  await world.reviewLogin({ enabled: true });
  const attacker = newSellerPhone();
  await startCode(world, attacker);
  const before = await world.sql('SELECT count(*)::int AS n FROM review_login_uses');
  const res = await verifyCode(world, { phone: attacker, code: REVIEW.code, device: newDevice() });
  refusedWith(res, [400, 401, 403], 'The review code on another number');
  assert.equal(res.data?.accessToken, undefined);
  const rows = await world.sql('SELECT * FROM review_login_uses ORDER BY id DESC LIMIT 5');
  const after = await world.sql('SELECT count(*)::int AS n FROM review_login_uses');
  assert.ok(after[0].n > before[0].n, 'The try on another number was not logged');
  assert.deepEqual([rows[0].accepted, rows[0].reason], [false, 'wrong_number']);
  assert.ok(!JSON.stringify(rows).includes(local10(attacker)), 'The log holds the number');
  assert.ok(!JSON.stringify(rows).includes(REVIEW.code), 'The log holds the code');
  // Looks like a wrong code to whoever tried it.
  const wrong = await verifyCode(world, { phone: attacker, code: wrongCode(REVIEW.code) });
  assert.equal(res.status, wrong.status);
});

test('F-50: the review code works for the review number with the flag on, is logged, and fails with the flag off', async () => {
  await world.reviewLogin({ enabled: true });
  await startCode(world, REVIEW.phone);
  const ok = await verifyCode(world, { phone: REVIEW.phone, code: REVIEW.code, device: newDevice('Review iPhone', 'ios') });
  assert.equal(ok.status, 201, `The review login: ${ok.status} ${ok.text.slice(0, 200)}`);
  const [accepted] = await world.sql('SELECT * FROM review_login_uses ORDER BY id DESC LIMIT 1');
  assert.deepEqual([accepted.accepted, accepted.reason], [true, '']);

  refusedWith(await verifyCode(world, { phone: REVIEW.phone, code: wrongCode(REVIEW.code) }), [400, 401, 403], 'A wrong code on the review number');
  const [wrong] = await world.sql('SELECT * FROM review_login_uses ORDER BY id DESC LIMIT 1');
  assert.deepEqual([wrong.accepted, wrong.reason], [false, 'wrong_code']);

  await world.reviewLogin({ enabled: false });
  await world.shift(CODE_RULES.resendAfterMs + SECOND, CODE_TABLES);
  await startCode(world, REVIEW.phone);
  refusedWith(await verifyCode(world, { phone: REVIEW.phone, code: REVIEW.code }), [400, 401, 403], 'The review code with the flag off');
  const [off] = await world.sql('SELECT * FROM review_login_uses ORDER BY id DESC LIMIT 1');
  assert.deepEqual([off.accepted, off.reason], [false, 'flag_off']);
  await world.reviewLogin({ enabled: true });
});

test('F-50: the review code is never a way past the per-number limit on another number', async () => {
  await world.reviewLogin({ enabled: true });
  const attacker = newSellerPhone();
  for (let i = 0; i < AUTH_LIMITS.codeTriesPerNumber.limit + 2; i++) {
    noCrash(await verifyCode(world, { phone: attacker, code: REVIEW.code }, { ip: randomIp() }), 'The review code, again');
  }
  const res = await verifyCode(world, { phone: attacker, code: REVIEW.code }, { ip: randomIp() });
  refusedWith(res, [400, 401, 403, 429], 'The review code after the limit');
  assert.equal(res.data?.accessToken, undefined);
});

test('P-11: before sign-in the app is told to offer a WhatsApp code and Google (and Apple on iOS), never a password or SMS', async () => {
  const android = await world.app('/api/v1/app/requirements?platform=android');
  assert.equal(android.status, 200, `app.requirements: ${android.status} ${android.text.slice(0, 200)}`);
  assert.deepEqual([android.data.signIn.whatsapp, android.data.signIn.google], [true, true]);
  const ios = await world.app('/api/v1/app/requirements?platform=ios');
  assert.equal(ios.status, 200);
  assert.deepEqual([ios.data.signIn.whatsapp, ios.data.signIn.google, ios.data.signIn.apple], [true, true, true], 'On iOS, Apple is offered beside Google and WhatsApp');
  for (const res of [android, ios]) {
    assert.deepEqual(Object.keys(res.data.signIn).sort(), ['apple', 'google', 'whatsapp']);
    assert.doesNotMatch(res.text, NO_SMS);
  }
});

test('P-11: the web sign-in page offers Google and a WhatsApp code, with no password field and no SMS', async () => {
  const page = await world.app(AUTH_PATHS.signIn, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200, `The web sign-in page: ${page.status}`);
  assert.doesNotMatch(page.text, /type=["']?password/i, 'The sign-in page has a password field');
  assert.doesNotMatch(page.text.replace(/<script[\s\S]*?<\/script>/gi, ''), /\bSMS\b|text message/i);
  assert.match(page.text, /google/i, 'No Google sign-in');
  assert.match(page.text, /whatsapp/i, 'No WhatsApp code');
  assert.match(page.text, /bhava/i, 'The seller sign-in page is not Bhava-branded');
  // A password is not a way in on the sign-in host.
  const shop = await addSeller(world);
  const password = await world.app('/api/v1/auth/login', { method: 'POST', body: { phone: shop.owner.phone, password: shop.owner.password } });
  assert.ok([401, 404].includes(password.status), `A password sign-in on the sign-in host answered ${password.status}`);
  assert.equal(password.data?.token, undefined);
});

test('F-117: a code goes from Bhava\'s number however many businesses the number works in', async () => {
  const a = await addSeller(world);
  const b = await addSeller(world);
  const phone = newSellerPhone();
  await a.repos.users.create({ name: 'Two Shops', phone: local10(phone), password: 'two-shops-pass-1', role: 'manager' });
  await b.repos.users.create({ name: 'Two Shops', phone: local10(phone), password: 'two-shops-pass-2', role: 'manager' });
  const seen = (await world.allMessagesTo(phone)).length;
  await codeFor(phone);
  const sent = (await world.allMessagesTo(phone)).slice(seen);
  assert.equal(sent.length, 1, 'One request sent more than one message');
  assert.equal(sent[0].phoneId, PLATFORM_PHONE_ID, 'The code came from a business\'s own number');
});
