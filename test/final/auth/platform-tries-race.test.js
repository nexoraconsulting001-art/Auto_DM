// auth-8 follow-up (PRD 5.5): the Platform Console's per-code and per-ticket try limits hold when the tries arrive
// together, made deterministic here instead of hoping a burst interleaves.
// - Emailed code: the tries used to be read, compared and only then counted, so guesses that read the count at the same
//   moment were all compared. The row is held locked while eight wrong guesses queue on it; when it is let go, at most
//   five may have been counted (and compared).
// - Authenticator ticket: a try turned away because another was in progress was not counted, so a burst could leave the
//   ticket alive for the right code. With a try held in progress, every try sent meanwhile now uses one up.
import { test } from 'node:test';
import crypto from 'node:crypto';
import { CONSOLE_HOST, assert, hit, json, need, one, totp, unique, useBillingWorld } from '../../p7/spec-p7/support.js';

// Real Postgres: one connection holds the code's row and eight guesses wait on it at once, so the owner's pool needs ten
// (the test database's default of three, two for the owner with two logins, let none reach the lock: R3-MONEY-7).
const world = useBillingWorld({ poolSize: 20 });
const ip = () => `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 250)}`;
const post = (path, body, from) => hit(world, path, { host: CONSOLE_HOST, method: 'POST', body, headers: { 'x-forwarded-for': from } });

async function newOperator() {
  const email = `race${unique()}@team.example`.toLowerCase();
  await world.platform.platformUsers.create({ email, password: 'console-pass-1', role: 'support', name: 'Meera' });
  return { email, id: (await one(world, 'SELECT id FROM platform_users WHERE email = $1', [email])).id };
}
async function mailedCode(email) {
  const last = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email)).at(-1);
  assert.ok(last, 'no code was emailed');
  return /(?<!\d)(\d{6})(?!\d)/.exec(`${last.text}${last.html}`)?.[1];
}
/**
 * Waits until `n` statements touching `table` wait on a lock, asking on the connection `t` that holds it. Postgres keeps
 * one pg_stat_activity snapshot for the rest of a transaction once it is read, so each look first drops it (R4-MONEY-4):
 * without that every look after the first saw the first moment's count, before any guess had arrived.
 */
async function waiters(t, table, n) {
  const end = Date.now() + 20_000;
  for (;;) {
    await t.query('SELECT pg_stat_clear_snapshot()');
    const [row] = await t.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [`%${table}%`],
    );
    if (row.n >= n) return;
    assert.ok(Date.now() < end, `only ${row.n} of ${n} tries reached the database`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('eight wrong emailed codes queued on one code get at most five looks, and the right code after them is refused', async () => {
  const { email, id } = await newOperator();
  assert.equal((await post('/sign-in/code', { email }, ip())).status, 204);
  const real = await mailedCode(email);
  const [code] = await world.rawDb.platform.query('SELECT id FROM platform_login_codes WHERE platform_user_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  const wrong = real === '000000' ? '000001' : '000000';
  const burst = () => Promise.all(Array.from({ length: 8 }, () => post('/sign-in/verify', { email, code: wrong }, ip())));
  let answers;
  if (world.rawDb.kind === 'postgres') {
    // Real Postgres: hold the row while the guesses queue on it (fewer than this world's pool, see useBillingWorld above).
    await world.rawDb.platform.tx(async (t) => {
      await t.query('SELECT id FROM platform_login_codes WHERE id = $1 FOR UPDATE', [code.id]);
      answers = burst();
      await waiters(t, 'platform_login_codes', 8);
    });
  } else {
    // PGlite runs every statement on one connection, so the guesses cannot overlap there: the burst is sent as is.
    answers = burst();
  }
  const done = await answers;
  assert.ok(done.every((a) => a.status === 400), done.map((a) => a.status).join(','));
  const [row] = await world.rawDb.platform.query('SELECT attempts, used_at FROM platform_login_codes WHERE id = $1', [code.id]);
  assert.ok(row.attempts <= 5, `${row.attempts} guesses were counted against one emailed code; at most 5`);
  assert.equal((await post('/sign-in/verify', { email, code: real }, ip())).status, 400, 'the right code after the burst');
});

test('tries sent while another try on the ticket is in progress each use one up, so the right code after them is refused', async () => {
  const { email } = await newOperator();
  const from = ip();
  assert.equal((await post('/sign-in/code', { email }, from)).status, 204);
  const t = json(need(await post('/sign-in/verify', { email, code: await mailedCode(email) }, from), 200, 'The emailed code'));
  // A try in progress on this ticket: the one-at-a-time hold platform.rateLimit keeps for it (scope platform_totp_busy).
  const subject = crypto.createHash('sha256').update(t.ticket).digest('base64url');
  const key = crypto.createHash('sha256').update(`platform_totp_busy\n${subject}`).digest('hex');
  await world.rawDb.platform.query('INSERT INTO rate_limit_hits (key, window_start, hits) VALUES ($1, now(), 1)', [key]);
  const right = totp(t.enrol.secret);
  const bad = right === '000000' ? '000001' : '000000';
  for (let i = 0; i < 6; i++) {
    const res = await post('/sign-in/totp', { ticket: t.ticket, code: bad }, from);
    assert.ok(res.status >= 400, `try ${i + 1} while another is in progress answered ${res.status}`);
  }
  await world.rawDb.platform.query('DELETE FROM rate_limit_hits WHERE key = $1', [key]);
  const late = await post('/sign-in/totp', { ticket: t.ticket, code: right }, from);
  assert.ok(late.status >= 400, `the right code after six turned-away tries answered ${late.status}`);
});
