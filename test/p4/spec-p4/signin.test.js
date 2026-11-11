// PRD 9.3: shopper sign-in with a WhatsApp code or Google, no password, no SMS. S-07 to S-11, S-92.
// Codes are read from what the WhatsApp simulator received, as the shopper's phone would show them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, SHOPPER_COOKIE, STORE_LIMITS, UA, addP4Shop, buyer, captureLogs, digits, need, newPhone, noCrash, noPlatformName, ok, onLocalDomain, refused, textOf, together, useP4World } from './kit.js';

const world = useP4World();
const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

test('S-07: the right code within five minutes signs the shopper in, by the business’s own WhatsApp number', async (t) => {
  const logs = captureLogs(t);
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const b = buyer(world, shop);
  const phone = newPhone();
  const sent = ok(await b.sendCode(phone), 'Asking for a code');
  noPlatformName('The send answer', sent.text);
  const [message] = await world.whatsappTo(phone);
  assert.ok(message, 'No WhatsApp message reached the number');
  assert.equal(message.type, 'template', 'A login code goes as an approved template, not free text');
  assert.equal(message.phoneId, shop.waPhoneId, 'The code was not sent from the business’s own WhatsApp number');
  noPlatformName('The code message', message.body);
  const code = await world.codeFor(phone);
  await world.age(4.5 * MINUTE);
  ok(await b.verifyCode(phone, code), 'Entering the code after four and a half minutes');
  assert.ok(b.signedIn, `No ${SHOPPER_COOKIE} cookie after the right code`);
  const me = await b.me();
  assert.ok(me, 'No shopper row for the number');
  assert.equal(me.phone, `+${digits(phone)}`);
  assert.ok(me.phone_verified_at, 'The phone is not marked verified');
  const [session] = await shop.sql('SELECT * FROM shopper_sessions WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id]);
  assert.equal(session.method, 'whatsapp_otp');
  need(await b.open('/account'), 200, 'The account page once signed in');
  // Nothing about the code or the number is kept or logged in the clear.
  const rows = await shop.sql('SELECT * FROM shopper_otps WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(rows).includes(code), 'The code is stored as it was sent');
  assert.ok(!JSON.stringify(rows).includes(digits(phone).slice(-10)), 'The phone number is stored in the clear with the code');
  assert.ok(!logs.text().includes(code), 'The code is in the logs');
  assert.ok(!logs.text().includes(digits(phone).slice(-10)), 'The phone number is in the logs');
});

test('S-07: the sign-in page keeps the way back to checkout, and never sends the shopper to another site', async () => {
  const shop = await addP4Shop(world);
  const b = buyer(world, shop);
  const page = need(await b.open('/login?next=%2Fcheckout'), 200, 'The sign-in page from checkout');
  assert.match(page.text, /\/checkout/, 'The sign-in page does not carry the shopper back to checkout');
  for (const next of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example', 'javascript:alert(1)']) {
    const res = noCrash(await b.open(`/login?next=${encodeURIComponent(next)}`), `The sign-in page with next=${next}`);
    assert.ok(!res.text.includes('evil.example') && !/javascript:alert/i.test(res.text), `The sign-in page would send the shopper to ${next}`);
    assert.ok(!String(res.headers.location ?? '').includes('evil.example'));
  }
});

test('S-07: a code older than five minutes, used twice, or replaced by a newer one is refused', async () => {
  const shop = await addP4Shop(world);
  const phone = newPhone();
  const late = buyer(world, shop);
  ok(await late.sendCode(phone), 'Asking for a code');
  const old = await world.codeFor(phone);
  await world.age(STORE_LIMITS.otp.validMs + 30_000);
  refused(await late.verifyCode(phone, old), 'A code after five minutes');
  assert.ok(!late.signedIn, 'An expired code signed the shopper in');

  const twice = buyer(world, shop);
  const phone2 = newPhone();
  ok(await twice.sendCode(phone2), 'Asking for a code');
  const code = await world.codeFor(phone2);
  ok(await twice.verifyCode(phone2, code), 'The first use');
  const again = buyer(world, shop);
  refused(await again.verifyCode(phone2, code), 'The same code a second time, on another browser');
  assert.ok(!again.signedIn);

  const replaced = buyer(world, shop);
  const phone3 = newPhone();
  ok(await replaced.sendCode(phone3), 'A first code');
  const first = await world.codeFor(phone3);
  ok(await replaced.sendCode(phone3), 'A second code');
  const second = await world.codeFor(phone3);
  if (first !== second) refused(await replaced.verifyCode(phone3, first), 'The code a newer one replaced');
  ok(await replaced.verifyCode(phone3, second), 'The newest code');
});

test('S-07: a code proves only its own number, its own purpose and its own store', async () => {
  const a = await addP4Shop(world);
  const b = await addP4Shop(world);
  const phone = newPhone();
  const other = newPhone();
  const atA = buyer(world, a);
  ok(await atA.sendCode(phone), 'A code at A');
  const code = await world.codeFor(phone);
  refused(await atA.verifyCode(other, code), 'The code with another number');
  refused(await atA.verifyCode(phone, code, 'cod'), 'A sign-in code used as a cash-on-delivery code');
  const atB = buyer(world, b);
  refused(await atB.verifyCode(phone, code), 'A’s code at B');
  assert.ok(!atB.signedIn && !atA.signedIn);
  ok(await atA.verifyCode(phone, code), 'The code where it belongs still works');
});

test('S-07: malformed sign-in calls are refused, never a server error', async () => {
  const shop = await addP4Shop(world);
  const b = buyer(world, shop);
  const bodies = [
    {}, { phone: '' }, { phone: 'abc', purpose: 'sign_in' }, { phone: '1'.repeat(40), purpose: 'sign_in' }, { phone: newPhone(), purpose: 'sms' },
    { phone: newPhone(), purpose: 'sign_in', channel: 'sms' }, { phone: newPhone(), purpose: 'sign_in', tenantId: 1 }, { phone: [newPhone()], purpose: 'sign_in' },
    { phone: `${newPhone()}\u0000`, purpose: 'sign_in' },
  ];
  for (const body of bodies) refused(await b.api('POST', '/api/store/otp/send', body), `Send ${JSON.stringify(body)}`, [400, 422]);
  const phone = newPhone();
  ok(await b.sendCode(phone), 'A real code');
  for (const code of ['12345', '1234567', 'abcdef', ' 12345', '12 345', '١٢٣٤٥٦', '000000\n', null, 123456]) {
    const res = await b.api('POST', '/api/store/otp/verify', { phone, purpose: 'sign_in', code });
    refused(res, `Code ${JSON.stringify(code)}`);
  }
  assert.ok(!b.signedIn);
});

test('S-08: three wrong codes invalidate the code: the right one then fails, and a new code must be asked for', async () => {
  const shop = await addP4Shop(world);
  const b = buyer(world, shop);
  const phone = newPhone();
  ok(await b.sendCode(phone), 'Asking for a code');
  const code = await world.codeFor(phone);
  for (let i = 0; i < STORE_LIMITS.otp.wrongTries; i++) {
    refused(await b.verifyCode(phone, wrongCode(code)), `Wrong code ${i + 1}`);
  }
  const right = refused(await b.verifyCode(phone, code), 'The right code after three wrong ones');
  assert.match(textOf(right.data?.error ?? right.text), /new code|request|again|expired|invalid/i, `No word about asking for a new code: ${right.text.slice(0, 200)}`);
  noCrash(await b.verifyCode(phone, wrongCode(code)), 'A fourth wrong code');
  assert.ok(!b.signedIn, 'Signed in after three wrong codes');
  const [row] = await shop.sql('SELECT attempts, invalidated_at, consumed_at FROM shopper_otps WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  assert.equal(row.attempts, 3);
  assert.ok(row.invalidated_at, 'The code was not invalidated');
  assert.equal(row.consumed_at, null);
  ok(await b.sendCode(phone), 'Asking for a new code');
  const fresh = await world.codeFor(phone);
  ok(await b.verifyCode(phone, fresh), 'The new code');
  assert.ok(b.signedIn);
});

test('S-08: guessing in parallel gets no more than three tries at one code', async () => {
  const shop = await addP4Shop(world);
  const phone = newPhone();
  const b = buyer(world, shop);
  ok(await b.sendCode(phone), 'Asking for a code');
  const code = await world.codeFor(phone);
  const guesses = Array.from({ length: 40 }, (_, i) => String((Number(code) + 1 + i * 7919) % 1_000_000).padStart(6, '0')).filter((g) => g !== code);
  const answers = await together(guesses.length, (i) => buyer(world, shop, { ip: `198.18.${i}.1` }).verifyCode(phone, guesses[i]));
  for (const res of answers) noCrash(res, 'A parallel guess');
  assert.ok(answers.every((r) => r.status >= 400), 'A wrong guess was accepted');
  refused(await b.verifyCode(phone, code), 'The right code after forty parallel guesses');
  const [row] = await shop.sql('SELECT attempts, invalidated_at FROM shopper_otps WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  assert.ok(row.attempts <= 3 && row.invalidated_at, `The code took ${row.attempts} tries and is ${row.invalidated_at ? '' : 'not '}invalidated`);
  const [{ n }] = await shop.sql('SELECT count(*)::int AS n FROM shopper_sessions WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(n, 0, 'A guess made a session');
});

test('S-09: the sixth code in an hour is refused with a wait message, and no WhatsApp message goes', async () => {
  const shop = await addP4Shop(world);
  const phone = newPhone();
  const b = buyer(world, shop);
  for (let i = 0; i < STORE_LIMITS.otp.sendsPerHour; i++) ok(await b.sendCode(phone), `Send ${i + 1}`);
  const sixth = refused(await b.sendCode(phone), 'The sixth send', 429);
  assert.match(sixth.data?.error ?? '', /wait|try again|later|minute|hour/i, `The refusal does not say to wait: ${sixth.text.slice(0, 200)}`);
  noPlatformName('The refusal', sixth.text);
  assert.equal((await world.whatsappTo(phone)).length, STORE_LIMITS.otp.sendsPerHour, 'A message went out for the refused send');
  await world.age(61 * MINUTE);
  ok(await b.sendCode(phone), 'A send after the hour has passed');
});

test('S-09: the hourly limit counts the number however it is written, at every instance', async () => {
  const shop = await addP4Shop(world);
  const phone = newPhone();
  const ten = digits(phone).slice(-10);
  const second = await world.secondInstance();
  const forms = [`+91${ten}`, `91${ten}`, ten, `+91 ${ten.slice(0, 5)} ${ten.slice(5)}`, `+91-${ten}`];
  for (let i = 0; i < forms.length; i++) {
    const b = buyer(world, shop, { app: i % 2 ? second : world });
    ok(await b.sendCode(forms[i]), `Send ${i + 1} as ${forms[i]}`);
  }
  const extra = buyer(world, shop, { app: second });
  refused(await extra.sendCode(`0${ten}`), 'A sixth send with the number written another way, at the other instance', 429);
  refused(await buyer(world, shop).sendCode(`+${digits(phone)}`), 'A sixth send', 429);
  assert.equal((await world.whatsappTo(phone)).length, 5);
});

test('S-09: one address cannot ask for codes for twenty numbers and more', async () => {
  const shop = await addP4Shop(world);
  const ip = '192.0.2.77';
  const phones = Array.from({ length: STORE_LIMITS.otp.sendsPerIpPerHour + 1 }, () => newPhone());
  const answers = [];
  for (const phone of phones) answers.push(await buyer(world, shop, { ip }).sendCode(phone));
  assert.ok(answers.slice(0, STORE_LIMITS.otp.sendsPerIpPerHour).every((r) => r.status < 300), 'Sends within the per-address limit were refused');
  refused(answers.at(-1), 'Send number 21 from one address', 429);
  assert.equal((await world.whatsappTo(phones.at(-1))).length, 0);
  ok(await buyer(world, shop, { ip: '192.0.2.78' }).sendCode(newPhone()), 'Another address is not held back');
});

test('S-10: inside Instagram’s browser the WhatsApp code is offered first, and there is no SMS anywhere', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const inApp = buyer(world, shop, { ua: UA.instagram });
  const page = need(await inApp.open('/login'), 200, 'The sign-in page in Instagram’s browser');
  const html = page.text;
  const text = textOf(html);
  const wa = text.search(/whatsapp/i);
  assert.ok(wa >= 0, 'The sign-in page does not offer a WhatsApp code');
  const google = text.search(/google/i);
  assert.ok(google === -1 || wa < google, 'Google is offered before the WhatsApp code in the in-app browser');
  assert.doesNotMatch(text, /\bSMS\b|text message|DLT/i, 'The page mentions SMS');
  assert.doesNotMatch(html, /name=["'](?:channel|via)["'][^>]*value=["']sms/i);
  assert.ok(!/<input[^>]+type=["']password/i.test(html), 'The sign-in page asks for a password');
  noPlatformName('The sign-in page', html);
  const chrome = need(await buyer(world, shop).open('/login'), 200, 'The sign-in page in Chrome');
  assert.doesNotMatch(textOf(chrome.text), /\bSMS\b/i);
  assert.match(textOf(chrome.text), /whatsapp/i);
});

test('S-11: the same phone at two stores is two accounts that never meet', async () => {
  const a = await addP4Shop(world, { name: 'Leafy Corner' });
  const b = await addP4Shop(world, { name: 'Brass Bazaar' });
  const phone = newPhone();
  const atA = buyer(world, a);
  await atA.signIn(phone);
  const product = await a.item({ name: 'Monstera only at A' });
  const placed = await atA.order({ lines: [{ productId: product.id, qty: 1 }] });
  ok(await atA.addAddress({ line1: 'Flat 9, A Street' }), 'An address at A');
  const atB = buyer(world, b);
  await atB.signIn(phone);
  const meA = await atA.me();
  const meB = await atB.me();
  assert.ok(meA && meB && meA.id !== meB.id, 'The same phone is one account at two stores');
  assert.notEqual(meA.tenant_id, meB.tenant_id);
  const orders = need(await atB.open('/account/orders'), 200, 'B’s order list');
  assert.ok(!orders.text.includes(placed.orderNumber) && !orders.text.includes('Monstera only at A'), 'A’s order shows at B');
  refused(await atB.open(`/account/orders/${encodeURIComponent(placed.orderNumber)}`), 'A’s order page at B', 404);
  const addresses = ok(await atB.addresses(), 'B’s addresses');
  assert.ok(!addresses.text.includes('A Street'), 'A’s address shows at B');
  // A’s session cookie means nothing at B.
  const carried = buyer(world, b);
  Object.assign(carried.jar, atA.jar);
  const res = await carried.addresses();
  assert.ok(res.status === 401 || !res.text.includes('A Street'), 'A’s session opened B’s account');
});

test('S-92: Google sign-in in Chrome signs the shopper in with no code', async () => {
  const base = await addP4Shop(world, { name: 'Leafy Corner' });
  const shop = await onLocalDomain(world, base);
  const b = buyer(world, shop);
  const before = (await world.wa.get('/sent')).sent.length;
  const { start, res } = await b.googleSignIn({ sub: 'g-chrome-1', email: 'asha@mail.example' });
  const auth = new URL(start.headers.location);
  assert.equal(auth.origin, world.google.url, 'Google sign-in does not go to Google');
  assert.ok(auth.searchParams.get('state'), 'Google sign-in has no state to check on the way back');
  noCrash(res, 'The way back from Google');
  assert.ok(b.signedIn, 'Not signed in after Google');
  const [row] = await base.sql('SELECT * FROM shoppers WHERE tenant_id = $1 AND google_sub = $2', [base.tenantId, 'g-chrome-1']);
  assert.ok(row, 'No shopper row for the Google account');
  assert.equal((await world.wa.get('/sent')).sent.length, before, 'A code was sent for a Google sign-in');
  const [session] = await base.sql('SELECT method FROM shopper_sessions WHERE tenant_id = $1 AND shopper_id = $2', [base.tenantId, row.id]);
  assert.equal(session.method, 'google');
});

test('S-92: a changed state, a refusal at Google or a replayed callback signs nobody in', async () => {
  const base = await addP4Shop(world);
  const shop = await onLocalDomain(world, base);
  const tampered = buyer(world, shop);
  await world.google.post('/next-user', { sub: 'g-tamper' });
  const start = await tampered.open('/auth/google');
  assert.ok([302, 303].includes(start.status), `Google sign-in did not start with a redirect: ${start.status}`);
  const consent = await fetch(start.headers.location, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  back.searchParams.set('state', `${back.searchParams.get('state')}x`);
  noCrash(await tampered.open(`${back.pathname}${back.search}`), 'The callback with a changed state');
  assert.ok(!tampered.signedIn, 'A changed state signed the shopper in');

  const elsewhere = buyer(world, shop);
  back.searchParams.delete('state');
  noCrash(await elsewhere.open(`${back.pathname}${back.search}`), 'The callback with no state, in another browser');
  assert.ok(!elsewhere.signedIn, 'A callback with no state signed someone in');

  const denied = buyer(world, shop);
  await world.google.post('/next-user', { sub: 'g-deny', deny: true });
  const s2 = await denied.open('/auth/google');
  const c2 = await fetch(s2.headers.location, { redirect: 'manual' });
  const b2 = new URL(c2.headers.get('location'));
  const res = noCrash(await denied.open(`${b2.pathname}${b2.search}`), 'Coming back after refusing at Google');
  assert.ok(!denied.signedIn);
  noPlatformName('The page after refusing', res.text);

  const ok1 = buyer(world, shop);
  const { back: done } = await ok1.googleSignIn({ sub: 'g-replay' });
  assert.ok(ok1.signedIn);
  const replay = buyer(world, shop);
  noCrash(await replay.open(`${done.pathname}${done.search}`), 'The same callback again in another browser');
  assert.ok(!replay.signedIn, 'A replayed callback signed a second browser in');
  const [{ n }] = await base.sql('SELECT count(*)::int AS n FROM shoppers WHERE tenant_id = $1 AND google_sub IN ($2, $3)', [base.tenantId, 'g-tamper', 'g-deny']);
  assert.equal(n, 0);
});
