import crypto from 'node:crypto';
import { PLATFORM_LOGIN } from '../../contracts/api/platform-ops.js';
import { log, reportError } from '../../platform/log.js';
import { Refusal, mountRoute, platformAudit } from './mount.js';
import { generateLoginCode, generateRecoveryCodes, generateSecret, hashLoginCode, hashRecoveryCode, otpauthUrl, verifyTotp } from './totp.js';

/**
 * Signing in to the Platform Console (PRD 5.5): an emailed code, then the authenticator. Never a seller's phone or password,
 * and never on a business's address (this router exists on the console host only).
 *
 *   signInStart   always 204, whether or not the address is one of ours. A live account gets a 6-digit code by email that
 *                 works once, for 10 minutes, and at most 5 wrong tries; asking again replaces it.
 *   signInVerify  the emailed code answers a ticket (5 minutes, kept as a hash in the cache) and, on a first sign-in, the
 *                 secret to add to an authenticator. It sets no cookie: the code alone never signs anyone in.
 *   signInTotp    the ticket plus the authenticator's code, or one recovery code. A time step is accepted once: the last one
 *                 used is kept with the secret and moved forward in one compare-and-set, so the same six digits never work
 *                 twice, not even in two requests at once. Five wrong codes end the ticket.
 *
 * The TOTP secret is stored encrypted (platform_users.totp_secret_enc) as { secret, lastStep }; totp_enrolled_at is set by
 * the first good code. Every step is limited per address (the failed-sign-in count of src/auth.js) and per account, and
 * every outcome is on the audit log with the platform user's id.
 */
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
const WRONG_CODE = 'That code isn’t right, or it has expired. Ask for a new one.';
const TICKET_GONE = 'This sign-in has expired. Start again.';
const CODES_PER_WINDOW = 5;
const CODE_WINDOW_SECONDS = 15 * 60;
const TICKET_TRIES = 5;

const describe = (user) => ({ id: user.id, email: user.email, name: user.name, role: user.role });

function readState(secrets, stored) {
  if (!stored) return null;
  try {
    const value = JSON.parse(secrets.decrypt(stored));
    return typeof value?.secret === 'string' ? { secret: value.secret, lastStep: Number.isSafeInteger(value.lastStep) ? value.lastStep : -1 } : null;
  } catch {
    // An old value stored as the bare secret.
    try {
      return { secret: secrets.decrypt(stored), lastStep: -1 };
    } catch {
      return null;
    }
  }
}
const writeState = (secrets, state) => secrets.encrypt(JSON.stringify({ secret: state.secret, lastStep: state.lastStep }));

/** The sign-in email. Bhava's own words to Bhava's own team: no business, no shopper. */
function codeMail(code) {
  const text = `Your Bhava Console sign-in code is ${code}. It works once, for ${PLATFORM_LOGIN.codeMinutes} minutes. If you did not ask for it, ignore this email and tell your admin.`;
  const html = `<p>Your Bhava Console sign-in code is <strong>${code}</strong>.</p><p>It works once, for ${PLATFORM_LOGIN.codeMinutes} minutes. If you did not ask for it, ignore this email and tell your admin.</p>`;
  return { subject: 'Your Bhava Console sign-in code', text, html };
}

/**
 * Sends the code. The notifications service (ctx.notify) only reaches sellers and Bhava's own email sender is its alone, so
 * there is no path for a message to Bhava's team yet: this uses the email driver directly, from PLATFORM_EMAIL_FROM (or the
 * neutral sending domain when that is not set). See the track's report: a team-mail call on ctx.notify should replace it.
 */
async function sendCode({ providers, config }, { to, code, codeId }) {
  const from = config.platformEmailFrom || (config.emailNeutralDomain ? `console@${config.emailNeutralDomain}` : '');
  const mail = providers?.email;
  if (!from || !mail?.send) {
    log.warn('platform.sign_in_code_unsent', { codeId, reason: 'no_sender' });
    return false;
  }
  await mail.send({ from, fromName: config.platformEmailFromName || 'Bhava', to, ...codeMail(code), idempotencyKey: `platform-code:${codeId}` });
  return true;
}

export function registerSignIn(router, ctx, auth) {
  const { db, config, platform } = ctx;
  const { cache, secrets } = platform;
  const pdb = db.platform ?? db;
  const ticketKey = (ticket) => `platform-ticket:${sha(ticket)}`;
  const audit = (userId, action, details = {}) => platformAudit(db, { actor: userId ? `platform:${userId}` : 'platform:anonymous', action, target: userId ? String(userId) : '', details }).catch((err) => reportError(err, { msg: 'platform.audit_failed', action }));

  const tooMany = async (req) => {
    if (await auth.tooManyAttempts(req)) throw new Refusal(429, 'Too many tries. Wait 15 minutes and try again.', 'rate_limited');
  };
  const userByEmail = async (email) => (await pdb.query('SELECT id, email, name, role, totp_secret_enc, totp_enrolled_at FROM platform_users WHERE email = $1 AND disabled_at IS NULL', [email]))[0] ?? null;

  mountRoute(router, 'platform.signInStart', async ({ body, req }) => {
    await tooMany(req);
    // At most five codes per address in 15 minutes, counted whether or not the address is ours, so the count says nothing.
    const countKey = `platform-code-sent:${sha(body.email)}`;
    const sent = (await cache.get(countKey)) ?? { n: 0, reset: Date.now() + CODE_WINDOW_SECONDS * 1000 };
    if (sent.n >= CODES_PER_WINDOW) {
      log.warn('platform.sign_in_code_limited', {});
      return;
    }
    await cache.set(countKey, { n: sent.n + 1, reset: sent.reset }, Math.max(1, (sent.reset - Date.now()) / 1000));
    const user = await userByEmail(body.email);
    if (!user) return;
    const code = generateLoginCode();
    const [row] = await pdb.tx(async (t) => {
      await t.query('UPDATE platform_login_codes SET used_at = now() WHERE platform_user_id = $1 AND used_at IS NULL', [user.id]);
      return t.query(
        `INSERT INTO platform_login_codes (platform_user_id, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`,
        [user.id, hashLoginCode(config.sessionSecret, user.id, code), PLATFORM_LOGIN.codeMinutes],
      );
    });
    try {
      await sendCode(ctx, { to: user.email, code, codeId: Number(row.id) });
    } catch (err) {
      reportError(err, { msg: 'platform.sign_in_code_failed', codeId: Number(row.id) });
    }
    await audit(user.id, 'platform.sign_in_code', { codeId: Number(row.id) });
  });

  mountRoute(router, 'platform.signInVerify', async ({ body, req }) => {
    await tooMany(req);
    const user = await userByEmail(body.email);
    const fail = async (codeId = null) => {
      await auth.recordFailure(req);
      if (user) await audit(user.id, 'platform.sign_in_code_wrong', { codeId });
      throw new Refusal(400, WRONG_CODE, 'bad_code');
    };
    if (!user) return fail();
    // The try is counted before the code is compared, in the statement that reads it, and only while tries are left: a
    // burst of guesses at once cannot get more than codeAttempts looks at one code (the seller codes do the same).
    const [row] = await pdb.query(
      `UPDATE platform_login_codes SET attempts = attempts + 1
       WHERE id = (SELECT id FROM platform_login_codes WHERE platform_user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1)
         AND used_at IS NULL AND expires_at > now() AND attempts < $2
       RETURNING id, code_hash`,
      [user.id, PLATFORM_LOGIN.codeAttempts],
    );
    if (!row) return fail();
    const expected = Buffer.from(row.code_hash);
    const given = Buffer.from(hashLoginCode(config.sessionSecret, user.id, body.code));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return fail(Number(row.id));
    // Spent here, in one statement, so two requests with the same code cannot both get a ticket.
    const spent = await pdb.query('UPDATE platform_login_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [row.id]);
    if (!spent.length) return fail(Number(row.id));

    let enrol = null;
    if (!user.totp_enrolled_at) {
      if (!secrets.configured) throw new Refusal(503, 'The console can’t set up an authenticator right now. Contact your admin.', 'not_configured');
      const secret = generateSecret();
      const updated = await pdb.query(`UPDATE platform_users SET totp_secret_enc = $2 WHERE id = $1 AND totp_enrolled_at IS NULL RETURNING id`, [user.id, writeState(secrets, { secret, lastStep: -1 })]);
      if (updated.length) enrol = { secret, otpauthUrl: otpauthUrl(secret, user.email) };
    }
    const ticket = crypto.randomBytes(32).toString('base64url');
    const until = Date.now() + PLATFORM_LOGIN.ticketMinutes * 60_000;
    await cache.set(ticketKey(ticket), { userId: user.id, tries: 0, until }, PLATFORM_LOGIN.ticketMinutes * 60);
    await audit(user.id, 'platform.sign_in_code_ok', { codeId: Number(row.id), enrol: Boolean(enrol) });
    return { ticket, next: enrol ? 'enrol' : 'totp', enrol };
  });

  mountRoute(router, 'platform.signInTotp', async ({ body, req, res }) => {
    await tooMany(req);
    const key = ticketKey(body.ticket);
    const held = await cache.get(key);
    if (!held || !(held.until > Date.now())) {
      await auth.recordFailure(req);
      throw new Refusal(400, TICKET_GONE, 'ticket_expired');
    }
    // Each try is counted first, atomically, whatever happens to it next: a burst cannot get more than TICKET_TRIES
    // looks, and a try turned away below because another is in progress still uses one up, so a burst spends the ticket.
    const ticketId = sha(body.ticket);
    const attempt = await platform.rateLimit.hit('platform_totp_tries', ticketId, { limit: TICKET_TRIES, windowMs: PLATFORM_LOGIN.ticketMinutes * 60_000 });
    if (!attempt.allowed) {
      await auth.recordFailure(req);
      await cache.del(key);
      throw new Refusal(400, TICKET_GONE, 'ticket_expired');
    }
    // One try at a time per ticket, taken in one statement so two requests at the same moment cannot both hold it.
    const busy = await platform.rateLimit.hit('platform_totp_busy', ticketId, { limit: 1, windowMs: 10_000 });
    if (!busy.allowed) throw new Refusal(429, 'Wait a moment and try again.', 'rate_limited');
    try {
      const [user] = await pdb.query('SELECT id, email, name, role, totp_secret_enc, totp_enrolled_at FROM platform_users WHERE id = $1 AND disabled_at IS NULL', [held.userId]);
      if (!user) {
        await cache.del(key);
        throw new Refusal(400, TICKET_GONE, 'ticket_expired');
      }
      const enrolling = !user.totp_enrolled_at;
      const accepted = await acceptCode(user, body.code, enrolling);
      if (!accepted) {
        await auth.recordFailure(req);
        const tries = attempt.hits;
        if (tries >= TICKET_TRIES) await cache.del(key);
        await audit(user.id, 'platform.sign_in_totp_wrong', { tries });
        throw new Refusal(400, tries >= TICKET_TRIES ? TICKET_GONE : 'That code isn’t right. Check your authenticator and try again.', 'bad_code');
      }
      await cache.del(key);
      let recoveryCodes;
      if (enrolling) {
        recoveryCodes = generateRecoveryCodes();
        await pdb.tx(async (t) => {
          await t.query('DELETE FROM platform_recovery_codes WHERE platform_user_id = $1', [user.id]);
          for (const code of recoveryCodes) await t.query('INSERT INTO platform_recovery_codes (platform_user_id, code_hash) VALUES ($1, $2)', [user.id, hashRecoveryCode(config.sessionSecret, code)]);
        });
      }
      const csrf = await auth.login(req, res, user);
      await audit(user.id, 'platform.sign_in', { method: accepted, enrolled: enrolling });
      log.info('platform.signed_in', { userId: user.id, method: accepted });
      return { user: describe(user), csrf, ...(recoveryCodes ? { recoveryCodes } : {}) };
    } finally {
      await platform.rateLimit.reset('platform_totp_busy', ticketId);
    }
  });

  /** 'totp' or 'recovery' when the code is good and now spent, otherwise null. */
  async function acceptCode(user, code, enrolling) {
    const state = readState(secrets, user.totp_secret_enc);
    if (!state) return null;
    if (code.includes('-')) {
      if (enrolling) return null;
      const used = await pdb.query(
        'UPDATE platform_recovery_codes SET used_at = now() WHERE platform_user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id',
        [user.id, hashRecoveryCode(config.sessionSecret, code)],
      );
      return used.length ? 'recovery' : null;
    }
    const step = verifyTotp(state.secret, code, { afterStep: state.lastStep });
    if (step === null) return null;
    const moved = await pdb.query(
      `UPDATE platform_users SET totp_secret_enc = $3, totp_enrolled_at = COALESCE(totp_enrolled_at, now()) WHERE id = $1 AND totp_secret_enc = $2 RETURNING id`,
      [user.id, user.totp_secret_enc, writeState(secrets, { secret: state.secret, lastStep: step })],
    );
    return moved.length ? 'totp' : null;
  }
}
