// auth-8 (PRD 5.5): the Platform Console's sign-in limits hold under bursts. Failures per address are counted atomically
// and are not wiped by someone else's successful sign-in from that address; a ticket takes at most five TOTP tries even
// when they arrive at the same moment. (The race itself needs a cache with network round trips, as Redis has; the
// unit test in platform-limiter.test.js shows it. These run the whole sign-in.)
import { test } from 'node:test';
import crypto from 'node:crypto';
import { CONSOLE_HOST, assert, hit, json, need, one, totp, unique, useBillingWorld } from '../../p7/spec-p7/support.js';

const world = useBillingWorld();
const ip = () => `203.0.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 250)}`;
const post = (path, body, from) => hit(world, path, { host: CONSOLE_HOST, method: 'POST', body, headers: { 'x-forwarded-for': from } });

async function newOperator() {
  const email = `lim${unique()}@team.example`.toLowerCase();
  await world.platform.platformUsers.create({ email, password: 'console-pass-1', role: 'support', name: 'Meera' });
  return { email, id: (await one(world, 'SELECT id FROM platform_users WHERE email = $1', [email])).id };
}
async function mailedCode(email) {
  const last = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email)).at(-1);
  return /(?<!\d)(\d{6})(?!\d)/.exec(`${last.text}${last.html}`)?.[1];
}
async function ticketFor(email, from) {
  assert.equal((await post('/sign-in/code', { email }, from)).status, 204);
  return json(need(await post('/sign-in/verify', { email, code: await mailedCode(email) }, from), 200, 'The emailed code'));
}

test('auth-8: a burst of wrong TOTP codes on one ticket gets at most five tries, and the right code after it is refused', async () => {
  const { email } = await newOperator();
  const from = ip();
  const t = await ticketFor(email, from);
  const right = totp(t.enrol.secret);
  const bad = right === '000000' ? '000001' : '000000';
  const answers = await Promise.all(Array.from({ length: 12 }, () => post('/sign-in/totp', { ticket: t.ticket, code: bad }, from)));
  const judged = answers.filter((a) => json(a)?.code === 'bad_code').length;
  assert.ok(judged <= 5, `${judged} wrong codes were checked against the authenticator on one ticket`);
  assert.ok(answers.every((a) => a.status >= 400), 'a wrong code never signs in');
  const late = await post('/sign-in/totp', { ticket: t.ticket, code: right }, from);
  assert.ok(late.status >= 400, `the right code after the burst answered ${late.status}`);
});

test('auth-8: a burst of wrong codes from one address is all counted, and the address is stopped', async () => {
  const { email } = await newOperator();
  const from = ip();
  await Promise.all(Array.from({ length: 14 }, () => post('/sign-in/verify', { email, code: '000000' }, from)));
  assert.equal((await post('/sign-in/verify', { email, code: '000000' }, from)).status, 429);
});

test('auth-8: a successful sign-in does not wipe the address\'s failures', async () => {
  const guesser = await newOperator();
  const from = ip();
  for (let i = 0; i < 9; i++) assert.equal((await post('/sign-in/verify', { email: guesser.email, code: '000000' }, from)).status, 400);
  // Someone else signs in from the same address (a shared office, or the attacker's own account).
  const { email } = await newOperator();
  const t = await ticketFor(email, from);
  need(await post('/sign-in/totp', { ticket: t.ticket, code: totp(t.enrol.secret) }, from), 200, 'Signing in');
  await post('/sign-in/verify', { email: guesser.email, code: '000000' }, from);
  assert.equal((await post('/sign-in/verify', { email: guesser.email, code: '000000' }, from)).status, 429, 'the count went back to zero on someone else\'s sign-in');
});
