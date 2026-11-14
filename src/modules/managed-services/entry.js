import crypto from 'node:crypto';
import { hashSessionToken, insertSession } from '../../repos/sessions.js';
import { log } from '../../platform/log.js';
import { currentTenant, normalizeHost, tenantId } from '../../tenancy.js';
import { fallbackHost } from '../domains/rules.js';

/**
 * The one-time address that opens a service operator's session on the business's own host (PRD 5.17). The console makes
 * it when the session starts; it is good for ENTRY_SECONDS and for one use. Opening it writes the seller cookie session
 * (the owner's account, with sessions.service_session_id set, never fresh, ending when the service session does) and
 * sets the cookie there. The address carries no secret of the session: it is signed, and the session is made only when
 * it is opened, once, under a lock on the service session.
 */
export const ENTRY_PATH = '/team-session';
const ENTRY_SECONDS = 60;
const COOKIE = 'sid'; // the seller console's session cookie (src/auth.js)

const keyOf = (config) => `${config.sessionSecret}:service-entry`;
const sign = (config, payload) => crypto.createHmac('sha256', keyOf(config)).update(payload).digest('base64url');

/** The signed entry token for service session `sessionId` of the current business. */
export function entryToken(config, sessionId) {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET is needed to open an operator session');
  const payload = Buffer.from(JSON.stringify({ t: tenantId(), s: Number(sessionId), e: Date.now() + ENTRY_SECONDS * 1000, n: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
  return `${payload}.${sign(config, payload)}`;
}

/** The token's { tenantId, sessionId } when it is genuine and in date, else null. */
export function readEntryToken(config, token) {
  const [payload, mac] = String(token ?? '').split('.');
  if (!payload || !mac || !config.sessionSecret || payload.length > 400) return null;
  const expected = sign(config, payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Number.isInteger(data.t) || !Number.isInteger(data.s) || !(Number(data.e) > Date.now())) return null;
    return { tenantId: data.t, sessionId: data.s };
  } catch {
    return null;
  }
}

/** Where the business's console is: its verified primary domain, else its address under the platform domain, else this host. */
export async function businessOrigin(platformDb, tenant, config) {
  const [primary] = await platformDb.query(`SELECT domain FROM tenant_domains WHERE tenant_id = $1 AND is_primary AND status = 'verified' LIMIT 1`, [tenant.id]);
  const host = primary?.domain || fallbackHost(tenant, config);
  return host ? `https://${normalizeHost(host)}` : '';
}

export function serviceEntryRoutes(app, ctx) {
  const platformDb = ctx.db.platform ?? ctx.db;
  const gone = (res) => res.status(410).type('text').send('This address has been used or is out of date. Start the session again from the console.');

  app.get(ENTRY_PATH, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      const found = readEntryToken(ctx.config, req.query.t);
      if (!found || found.tenantId !== currentTenant()?.id) return gone(res);
      const token = await platformDb.tx(async (t) => {
        // One opening per service session, whoever races for it.
        await t.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', ['service-entry', found.sessionId]);
        const [session] = await t.query(
          `SELECT id, extract(epoch FROM (expires_at - now())) AS left_s FROM service_sessions
           WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL AND expires_at > now() + interval '5 seconds'`,
          [found.tenantId, found.sessionId],
        );
        if (!session) return null;
        const [used] = await t.query('SELECT 1 FROM sessions WHERE tenant_id = $1 AND service_session_id = $2 LIMIT 1', [found.tenantId, found.sessionId]);
        if (used) return null;
        const [owner] = await t.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [found.tenantId]);
        if (!owner) return null;
        const made = await insertSession(t, { tenantId: found.tenantId, userId: owner.id, kind: 'cookie', seconds: Math.floor(Number(session.left_s)), fresh: false });
        await t.query('UPDATE sessions SET service_session_id = $3, fresh_until = NULL WHERE tenant_id = $1 AND id = $2', [found.tenantId, hashSessionToken(made), found.sessionId]);
        return { made, seconds: Math.floor(Number(session.left_s)) };
      });
      if (!token) {
        log.warn('services.entry_refused', { tenantId: found.tenantId, serviceSessionId: found.sessionId });
        return gone(res);
      }
      res.cookie(COOKIE, token.made, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: token.seconds * 1000 });
      log.info('services.entry_opened', { tenantId: found.tenantId, serviceSessionId: found.sessionId });
      return res.redirect(302, '/admin');
    } catch (err) {
      return next(err);
    }
  });
}
