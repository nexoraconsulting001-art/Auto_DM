// Final attack on the Platform Console's sign-in (PRD 5.5, 5.10): bursts sent at once against the per-address code limit,
// the five wrong tries of an emailed code, the per-address failure limit, and impersonation's one-time entry address.
import { test } from 'node:test';
import crypto from 'node:crypto';
import { CONSOLE_HOST, assert, hit, one, unique, useBillingWorld } from '../../p7/spec-p7/support.js';

const world = useBillingWorld();
const ip = () => `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 250)}`;
const post = (path, body, from) => hit(world, path, { host: CONSOLE_HOST, method: 'POST', body, headers: { 'x-forwarded-for': from } });

async function newOperator(role = 'support') {
  const email = `atk${unique()}@team.example`.toLowerCase();
  await world.platform.platformUsers.create({ email, password: 'console-pass-1', role, name: 'Attack Op' });
  const { id } = await one(world, 'SELECT id FROM platform_users WHERE email = $1', [email]);
  return { email, id };
}
const mails = async (email) => (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email));
async function mailedCode(email) {
  const last = (await mails(email)).at(-1);
  assert.ok(last, 'no code was emailed');
  return /(?<!\d)(\d{6})(?!\d)/.exec(`${last.text}${last.html}`)?.[1];
}

test('twelve code requests for one address sent at once email at most five codes (five per 15 minutes)', async () => {
  const { email } = await newOperator();
  const answers = await Promise.all(Array.from({ length: 12 }, () => post('/sign-in/code', { email }, ip())));
  assert.ok(answers.every((a) => a.status === 204), answers.map((a) => a.status).join(','));
  const sent = (await mails(email)).length;
  assert.ok(sent <= 5, `a burst of 12 emailed ${sent} codes; the limit is 5 per 15 minutes`);
});

test('twelve wrong emailed codes sent at once count as at most five tries against that code', async () => {
  const { email, id } = await newOperator();
  assert.equal((await post('/sign-in/code', { email }, ip())).status, 204);
  const real = await mailedCode(email);
  const wrongs = new Set();
  while (wrongs.size < 12) {
    const guess = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (guess !== real) wrongs.add(guess);
  }
  const answers = await Promise.all([...wrongs].map((code) => post('/sign-in/verify', { email, code }, ip())));
  assert.ok(answers.every((a) => a.status === 400), answers.map((a) => a.status).join(','));
  const row = await one(world, 'SELECT attempts FROM platform_login_codes WHERE platform_user_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  assert.ok(row.attempts <= 5, `${row.attempts} guesses were checked against one emailed code; at most 5 wrong tries`);
  assert.equal((await post('/sign-in/verify', { email, code: real }, ip())).status, 400, 'the right code after the burst');
});

test('one address sending thirty wrong codes at once is held to ten failures in the window', async () => {
  const { email } = await newOperator();
  const from = ip();
  assert.equal((await post('/sign-in/code', { email }, from)).status, 204);
  // Many operators' addresses are not needed: one email, many guesses, all from one address at once.
  const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => post('/sign-in/verify', { email, code: String(100000 + i) }, from)));
  const checked = answers.filter((a) => a.status === 400).length;
  const limited = answers.filter((a) => a.status === 429).length;
  assert.equal(checked + limited, 30, answers.map((a) => a.status).join(','));
  assert.ok(checked <= 10, `${checked} of 30 guesses from one address were checked; the address limit is 10 failures per 15 minutes`);
});

test('a forged, empty, huge or NUL ticket or email never signs in and never answers 5xx', async () => {
  const from = ip();
  for (const ticket of ['', 'x'.repeat(10_000), 'a\u0000b', 123, null, ['t'], { $ne: '' }]) {
    const res = await post('/sign-in/totp', { ticket, code: '123456' }, from);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(ticket)?.slice(0, 30)} answered ${res.status}`);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  for (const body of [{ email: 'x'.repeat(10_000), code: '123456' }, { email: ['a@b.c'], code: '123456' }, { email: 'a@b.c', code: 123456 }, { email: 'a\u0000@b.c', code: '123456' }]) {
    const res = await post('/sign-in/verify', body, from);
    assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body).slice(0, 40)} answered ${res.status}`);
  }
  for (const email of ['a\u0000@b.c', 'op\u0000@team.example', 'x'.repeat(10_000), ['a@b.c'], 42]) {
    const res = await post('/sign-in/code', { email }, from);
    assert.ok(res.status === 204 || (res.status >= 400 && res.status < 500), `sign-in/code ${JSON.stringify(email).slice(0, 30)} answered ${res.status}`);
  }
  assert.equal((await hit(world, '/me', { host: CONSOLE_HOST })).status, 401);
});

