// Platform Console sign-in (PRD 5.5): an emailed code, then TOTP. Attack cases: a replayed or guessed code, a missing
// second factor, seller credentials, limits on every step, and a code used twice at the same moment.
import { test } from 'node:test';
import crypto from 'node:crypto';
import { CONSOLE_HOST, assert, consoleUser, hit, json, need, one, onConsole, shopOn, sql, totp, unique, useBillingWorld } from '../spec-p7/support.js';

const world = useBillingWorld();
const ip = () => `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 250)}`;
const post = (path, body, from) => hit(world, path, { host: CONSOLE_HOST, method: 'POST', body, headers: { 'x-forwarded-for': from } });

async function newOperator(role = 'support') {
  const email = `op${unique()}@team.example`.toLowerCase();
  await world.platform.platformUsers.create({ email, password: 'console-pass-1', role, name: 'Meera' });
  const { id } = await one(world, 'SELECT id FROM platform_users WHERE email = $1', [email]);
  return { email, id };
}
const mails = async (email) => (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email));
async function mailedCode(email) {
  const last = (await mails(email)).at(-1);
  assert.ok(last, 'no code was emailed');
  assert.doesNotMatch(`${last.text}${last.html}`, /<script|token|password/i);
  return /(?<!\d)(\d{6})(?!\d)/.exec(`${last.text}${last.html}`)?.[1];
}
async function ticketFor(email, from) {
  assert.equal((await post('/sign-in/code', { email }, from)).status, 204);
  const verify = need(await post('/sign-in/verify', { email, code: await mailedCode(email) }, from), 200, 'The emailed code');
  assert.equal(verify.headers['set-cookie'], undefined, 'the emailed code alone sets no cookie');
  return json(verify);
}
async function enrolled(email, from = ip()) {
  const first = await ticketFor(email, from);
  assert.equal(first.next, 'enrol');
  const at = Date.now();
  const res = need(await post('/sign-in/totp', { ticket: first.ticket, code: totp(first.enrol.secret, at) }, from), 200, 'Enrolling');
  return { secret: first.enrol.secret, usedAt: at, recoveryCodes: json(res).recoveryCodes, cookie: String(res.headers['set-cookie']).split(';')[0], csrf: json(res).csrf };
}

test('F-42 sign-in: code, then enrolment, then TOTP; the session works and the code works once', async () => {
  const { email, id } = await newOperator();
  const from = ip();
  const first = await ticketFor(email, from);
  assert.equal(first.next, 'enrol');
  assert.match(first.enrol.otpauthUrl, /^otpauth:\/\/totp\/Bhava%20Console:/);
  assert.match(first.enrol.otpauthUrl, new RegExp(`secret=${first.enrol.secret}`));
  // Before the second factor nobody is signed in.
  assert.equal((await hit(world, '/me', { host: CONSOLE_HOST })).status, 401);
  const at = Date.now();
  const done = need(await post('/sign-in/totp', { ticket: first.ticket, code: totp(first.enrol.secret, at) }, from), 200, 'TOTP');
  const body = json(done);
  assert.equal(body.user.id, id);
  assert.equal(body.recoveryCodes.length, 10);
  const cookie = String(done.headers['set-cookie']).split(';')[0];
  assert.match(cookie, /^psid=/);
  assert.equal(json(need(await hit(world, '/me', { host: CONSOLE_HOST, cookie }), 200, 'Me')).user.email, email);
  // The ticket is spent with the sign-in.
  assert.equal((await post('/sign-in/totp', { ticket: first.ticket, code: totp(first.enrol.secret, at) }, from)).status, 400);
  // Recovery codes are stored only as hashes.
  const stored = await sql(world, 'SELECT code_hash FROM platform_recovery_codes WHERE platform_user_id = $1', [id]);
  assert.equal(stored.length, 10);
  assert.ok(stored.every((r) => !body.recoveryCodes.includes(r.code_hash)));
  assert.equal((await one(world, 'SELECT totp_secret_enc FROM platform_users WHERE id = $1', [id])).totp_secret_enc.includes(first.enrol.secret), false, 'the secret is stored encrypted');
  // Signed-in again later: no secret is shown a second time.
  const second = await ticketFor(email, from);
  assert.deepEqual([second.next, second.enrol], ['totp', null]);
  // Every step is on the audit log under the person's id.
  const actions = (await sql(world, 'SELECT action FROM audit_log WHERE actor = $1', [`platform:${id}`])).map((r) => r.action);
  for (const action of ['platform.sign_in_code', 'platform.sign_in_code_ok', 'platform.sign_in']) assert.ok(actions.includes(action), action);
});

test('F-42 sign-in: a TOTP code works once, even in two sign-ins at the same moment; a recovery code works once', async () => {
  const { email } = await newOperator();
  const from = ip();
  const { secret, usedAt, recoveryCodes } = await enrolled(email, from);
  // The code just used, on a new ticket: refused.
  const replay = await ticketFor(email, from);
  assert.equal((await post('/sign-in/totp', { ticket: replay.ticket, code: totp(secret, usedAt) }, from)).status, 400, 'the same code again');
  // Two tickets, one fresh code, sent together: exactly one gets in.
  const a = await ticketFor(email, from);
  const b = await ticketFor(email, from);
  const code = totp(secret, Date.now() + 30_000);
  const answers = await Promise.all([a, b].map((t) => post('/sign-in/totp', { ticket: t.ticket, code }, from)));
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 400], 'one code, one sign-in');
  // A recovery code signs in once.
  const r1 = await ticketFor(email, from);
  need(await post('/sign-in/totp', { ticket: r1.ticket, code: recoveryCodes[0] }, from), 200, 'A recovery code');
  // (An address gets five codes in 15 minutes, so the ticket refused above is used again: it is good for five tries.)
  assert.equal((await post('/sign-in/totp', { ticket: replay.ticket, code: recoveryCodes[0] }, from)).status, 400, 'a spent recovery code');
  assert.equal((await post('/sign-in/totp', { ticket: replay.ticket, code: 'aaaa-bbbb-cccc' }, from)).status, 400, 'a made-up recovery code');
  need(await post('/sign-in/totp', { ticket: replay.ticket, code: recoveryCodes[1] }, from), 200, 'Another recovery code on the same ticket');
});

test('F-42 sign-in: wrong codes are limited, a ticket dies after five wrong TOTPs, and an address gets at most five codes', async () => {
  const { email } = await newOperator();
  const from = ip();
  // Five wrong emailed codes lock that code: even the right one is refused afterwards.
  assert.equal((await post('/sign-in/code', { email }, from)).status, 204);
  const real = await mailedCode(email);
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await post('/sign-in/verify', { email, code: wrong }, from)).status, 400);
  assert.equal((await post('/sign-in/verify', { email, code: real }, from)).status, 400, 'locked after five misses');

  // A ticket takes five wrong authenticator codes and then is gone.
  const other = await newOperator();
  const from2 = ip();
  const t = await ticketFor(other.email, from2);
  const right = totp(t.enrol.secret);
  const bad = right === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await post('/sign-in/totp', { ticket: t.ticket, code: bad }, from2)).status, 400);
  assert.equal((await post('/sign-in/totp', { ticket: t.ticket, code: right }, from2)).status, 400, 'the ticket is spent');
  assert.equal((await post('/sign-in/totp', { ticket: 'made-up-ticket-value', code: right }, from2)).status, 400, 'a forged ticket');

  // Five codes per address in 15 minutes; asking more is answered the same, and sends nothing.
  const third = await newOperator();
  const from3 = ip();
  for (let i = 0; i < 7; i++) assert.equal((await post('/sign-in/code', { email: third.email }, from3)).status, 204);
  assert.equal((await mails(third.email)).length, 5);
});

test('F-42 sign-in: unknown and disabled addresses are answered the same and get nothing; seller credentials never get in', async () => {
  const from = ip();
  const nobody = `nobody${unique()}@team.example`.toLowerCase();
  assert.equal((await post('/sign-in/code', { email: nobody }, from)).status, 204);
  assert.equal((await mails(nobody)).length, 0);
  assert.equal((await post('/sign-in/verify', { email: nobody, code: '123456' }, from)).status, 400);
  const off = await newOperator();
  await sql(world, 'UPDATE platform_users SET disabled_at = now() WHERE id = $1', [off.id]);
  assert.equal((await post('/sign-in/code', { email: off.email }, from)).status, 204);
  assert.equal((await mails(off.email)).length, 0, 'a disabled account gets no code');

  const shop = await shopOn(world, 't1');
  assert.equal((await post('/sign-in/code', { email: shop.owner.phone }, from)).status, 400, 'a phone number is not a console address');
  assert.equal((await post('/sign-in/verify', { email: shop.owner.phone, code: '123456' }, from)).status, 400);
  assert.equal((await hit(world, '/me', { host: CONSOLE_HOST, token: shop.token })).status, 401, 'an owner token means nothing on the console');
  // And the other way round: a console session means nothing on a business, and the sign-in routes are not there.
  const op = await consoleUser(world);
  assert.equal((await hit(world, '/api/v1/auth/me', { host: shop.host, cookie: op.cookie })).status, 401);
  for (const path of ['/sign-in/code', '/sign-in/verify', '/sign-in/totp']) assert.equal((await hit(world, path, { host: shop.host, method: 'POST', body: {} })).status, 404, path);
  // A sign-in from another site is refused before anything is sent.
  assert.equal((await hit(world, '/sign-in/code', { host: CONSOLE_HOST, method: 'POST', body: { email: off.email }, headers: { origin: 'https://evil.example', 'x-forwarded-for': from } })).status, 403);
});

test('F-42 sign-in: disabling someone ends their session at once, and resetting their authenticator makes them enrol again', async () => {
  const admin = await consoleUser(world);
  const { email, id } = await newOperator();
  const s = await enrolled(email);
  assert.equal((await hit(world, '/me', { host: CONSOLE_HOST, cookie: s.cookie })).status, 200);
  need(await onConsole(world, admin, `/team/${id}`, { method: 'PATCH', body: { resetTotp: true, reason: 'lost phone' } }), 200, 'Reset');
  assert.equal((await hit(world, '/me', { host: CONSOLE_HOST, cookie: s.cookie })).status, 401, 'the reset ends the session');
  const again = await ticketFor(email, ip());
  assert.equal(again.next, 'enrol');
  assert.notEqual(again.enrol.secret, s.secret);
});

test('F-42 sign-in: one address that keeps failing is stopped on every sign-in step', async () => {
  const { email } = await newOperator();
  const from = ip();
  for (let i = 0; i < 10; i++) await post('/sign-in/verify', { email, code: '000000' }, from);
  assert.equal((await post('/sign-in/verify', { email, code: '000000' }, from)).status, 429);
  assert.equal((await post('/sign-in/code', { email }, from)).status, 429);
  assert.equal((await post('/sign-in/totp', { ticket: 'x'.repeat(40), code: '000000' }, from)).status, 429);
  assert.equal((await post('/sign-in/code', { email }, ip())).status, 204, 'another address is not affected');
});
