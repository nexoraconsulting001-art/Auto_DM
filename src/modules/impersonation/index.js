import crypto from 'node:crypto';
import { IMPERSONATION_MINUTES, IMPERSONATION_ROLES } from '../../contracts/api/access.js';
import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { log, reportError } from '../../platform/log.js';
import { currentTenant, tenantId } from '../../tenancy.js';
import { hashSessionToken } from '../../repos/sessions.js';
import { fallbackHost } from '../domains/rules.js';
import { Refusal, idCursor, mountRoute, platformAudit } from '../platform-console/mount.js';

const PLATFORM = OPS_PLATFORM_OWNERS.impersonation;

/** The one-time address that opens the session on the business's own host (good for a minute, once). */
export const ENTRY_PATH = '/operator/enter';
const ENTRY_SECONDS = 60;
const ENTRY_LOCK = 73010;
const entryKey = (token) => `impersonation-entry:${crypto.createHash('sha256').update(String(token)).digest('base64url')}`;
/** What the operator types to confirm write mode is compared without case or extra spaces. */
const sameName = (a, b) => String(a).trim().replace(/\s+/g, ' ').toLowerCase() === String(b).trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether the platform user who opened an operator session may still hold it: not turned off, and still in one of `roles`.
 * platform_users is not readable inside a business, so this one read is on the platform path. Taking access or a role
 * away ends the sessions in the same transaction (platform.updateTeamMember); this is the check behind that.
 */
export async function operatorStillAllowed(db, operatorId, roles) {
  const [row] = await (db.platform ?? db).query('SELECT 1 FROM platform_users WHERE id = $1 AND disabled_at IS NULL AND role = ANY($2::text[])', [Number(operatorId), [...roles]]);
  return Boolean(row);
}

/**
 * What the API router asks on every request of an impersonated session (PRD 5.10). Read inside the business: the row is
 * fenced, and business code can only read it. Starting, confirming write mode and ending are the platform's, through
 * db.platform, in the Platform Console routes this module mounts.
 */
export function impersonationRepo(db) {
  return {
    /**
     * The live session with this id in the current business, as req.session.operator, or null once it ended, its 30
     * minutes are up, or the operator who opened it was turned off or no longer has a role that may impersonate.
     */
    async live(id) {
      const [row] = await db.query(
        `SELECT i.id, i.operator_id, i.operator_name, i.owner_user_id, i.mode, i.expires_at
         FROM impersonation_sessions i
         WHERE i.tenant_id = $1 AND i.id = $2 AND i.ended_at IS NULL AND i.expires_at > now()`,
        [tenantId(), Number(id)],
      );
      if (!row || !(await operatorStillAllowed(db, row.operator_id, IMPERSONATION_ROLES))) return null;
      return { kind: 'impersonation', id: Number(row.id), operatorId: row.operator_id, operatorName: row.operator_name || 'Bhava support', ownerId: row.owner_user_id, mode: row.mode, service: null, taskRef: null, expiresAt: row.expires_at };
    },
  };
}

const SESSION = `i.id, i.tenant_id, t.name AS tenant_name, i.operator_id, i.operator_name, i.reason, i.mode, i.started_at, i.expires_at, i.ended_at`;
const toSession = (r) => ({
  id: Number(r.id), tenantId: r.tenant_id, tenantName: r.tenant_name ?? '', operatorId: r.operator_id, operatorName: r.operator_name || '', reason: r.reason,
  mode: r.mode, startedAt: r.started_at, expiresAt: r.expires_at, endedAt: r.ended_at ?? null,
});

/**
 * The Platform Console's half (PRD 5.10, F-42 to F-45):
 *
 *   platform.impersonate                 POST /tenants/:id/impersonate { reason }: a read-only session as the owner, at most
 *                                        30 minutes (the table's CHECK holds it), and a one-time address on the business's host
 *   platform.impersonations              past and live sessions, newest first
 *   platform.confirmImpersonationWrite   the second confirmation: the business's name typed again and a reason. Only the
 *                                        operator who started the session, and only while it is live
 *   platform.endImpersonation            ends it now: the session row and every cookie it opened
 *
 * The business's half is GET ENTRY_PATH?t=<token>: it works once, within a minute, on that business's own address only, and
 * sets the normal seller cookie of a sessions row that names the impersonation (never fresh, expiring with it). From then on
 * the API router (src/modules/api-v1/operator.js) applies the rules of src/contracts/api/access.js to every request and
 * writes one audit row per request with both people's ids. All of it is on the audit log with the reason.
 */
export function registerImpersonationRoutes(router, ctx) {
  const { db, config, platform } = ctx;
  const pdb = db.platform ?? db;
  const sessionById = async (id) => (await pdb.query(`SELECT ${SESSION} FROM impersonation_sessions i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = $1`, [id]))[0] ?? null;

  mountRoute(router, 'platform.impersonate', async ({ params, body, user, actor }) => {
    const [tenant] = await pdb.query('SELECT id, slug, name, status FROM tenants WHERE id = $1', [params.id]);
    if (!tenant) throw new Refusal(404, 'Not found.');
    if (tenant.status === 'closed') throw new Refusal(409, 'This business is closed.', 'conflict');
    const [owner] = await pdb.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [tenant.id]);
    if (!owner) throw new Refusal(409, 'This business has no owner account to open.', 'conflict');
    const row = await pdb.tx(async (t) => {
      // One live session per operator and business: starting again ends the last one and its cookie.
      const ended = await t.query(`UPDATE impersonation_sessions SET ended_at = now() WHERE tenant_id = $1 AND operator_id = $2 AND ended_at IS NULL RETURNING id`, [tenant.id, user.id]);
      if (ended.length) await t.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND impersonation_id = ANY($2::bigint[]) AND revoked_at IS NULL', [tenant.id, ended.map((r) => r.id)]);
      const [made] = await t.query(
        `INSERT INTO impersonation_sessions (tenant_id, operator_id, operator_name, owner_user_id, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING id`,
        [tenant.id, user.id, String(user.name || 'Bhava support').slice(0, 80), owner.id, body.reason, IMPERSONATION_MINUTES],
      );
      return made;
    });
    const token = crypto.randomBytes(32).toString('base64url');
    await platform.cache.set(entryKey(token), { tenantId: tenant.id, impersonationId: Number(row.id), until: Date.now() + ENTRY_SECONDS * 1000 }, ENTRY_SECONDS);
    await platformAudit(db, { tenantId: tenant.id, actor, action: 'impersonation.start', target: String(row.id), details: { reason: body.reason, impersonationId: Number(row.id), operatorId: user.id, ownerId: owner.id, mode: 'read' } });
    log.info('impersonation.started', { tenant: tenant.id, impersonationId: Number(row.id), operatorId: user.id });
    const [primary] = await pdb.query(`SELECT domain FROM tenant_domains WHERE tenant_id = $1 AND is_primary AND status = 'verified'`, [tenant.id]);
    const host = primary?.domain || fallbackHost(tenant, config);
    const url = `${host ? `https://${host}` : ''}${ENTRY_PATH}?t=${token}`;
    return { url, session: toSession(await sessionById(row.id)) };
  });

  mountRoute(router, 'platform.impersonations', async ({ query }) => {
    const live = query.live === undefined ? null : query.live === 'true';
    const rows = await pdb.query(
      `SELECT ${SESSION} FROM impersonation_sessions i JOIN tenants t ON t.id = i.tenant_id
        WHERE ($1::integer IS NULL OR i.tenant_id = $1)
          AND ($2::boolean IS NULL OR (i.ended_at IS NULL AND i.expires_at > now()) = $2)
          AND ($3::bigint IS NULL OR i.id < $3)
        ORDER BY i.id DESC LIMIT $4`,
      [query.tenantId ? Number(query.tenantId) : null, live, idCursor(query.cursor), query.limit + 1],
    );
    const items = rows.slice(0, query.limit).map(toSession);
    return { items, nextCursor: rows.length > query.limit ? String(items.at(-1).id) : null };
  });

  mountRoute(router, 'platform.confirmImpersonationWrite', async ({ params, body, user, actor }) => {
    const found = await sessionById(params.id);
    if (!found) throw new Refusal(404, 'Not found.');
    if (found.operator_id !== user.id) throw new Refusal(403, 'Only the person who started this session can turn on write mode.', 'forbidden');
    if (found.ended_at || new Date(found.expires_at).getTime() <= Date.now()) throw new Refusal(409, 'This session has ended. Start another to help this business.', 'conflict');
    if (!sameName(body.confirm, found.tenant_name)) throw new Refusal(400, 'Type the business’s name exactly as it is shown to confirm.', 'validation');
    const changed = await pdb.query(
      `UPDATE impersonation_sessions SET mode = 'write', write_confirmed_at = COALESCE(write_confirmed_at, now())
        WHERE id = $1 AND operator_id = $2 AND ended_at IS NULL AND expires_at > now() RETURNING id`,
      [found.id, user.id],
    );
    if (!changed.length) throw new Refusal(409, 'This session has ended. Start another to help this business.', 'conflict');
    await platformAudit(db, { tenantId: found.tenant_id, actor, action: 'impersonation.write_mode', target: String(found.id), details: { reason: body.reason, impersonationId: Number(found.id), operatorId: user.id } });
    log.info('impersonation.write_mode', { tenant: found.tenant_id, impersonationId: Number(found.id), operatorId: user.id });
    return toSession(await sessionById(found.id));
  });

  mountRoute(router, 'platform.endImpersonation', async ({ params, user, actor }) => {
    const found = await sessionById(params.id);
    if (!found) throw new Refusal(404, 'Not found.');
    await pdb.tx(async (t) => {
      await t.query('UPDATE impersonation_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [found.id]);
      await t.query('UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND impersonation_id = $2 AND revoked_at IS NULL', [found.tenant_id, found.id]);
    });
    if (!found.ended_at) {
      await platformAudit(db, { tenantId: found.tenant_id, actor, action: 'impersonation.end', target: String(found.id), details: { impersonationId: Number(found.id), operatorId: user.id, startedBy: found.operator_id } });
      log.info('impersonation.ended', { tenant: found.tenant_id, impersonationId: Number(found.id), operatorId: user.id });
    }
    return toSession(await sessionById(found.id));
  });
}

/**
 * GET ENTRY_PATH?t=<token> on the business's own address. Spends the token (a minute, once, this business only), writes
 * the sessions row under a lock so a second use finds one already there, and sets the cookie. The address is never cached
 * and sends no referrer, so the token goes nowhere else.
 */
export function mountEntry(app, { db, platform }) {
  const gone = (res) => res.status(404).type('text').send('This link has expired. Start again from the console.');
  app.get(ENTRY_PATH, async (req, res, next) => {
    const tenant = currentTenant();
    if (!tenant) return next();
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const token = typeof req.query.t === 'string' && /^[\w-]{20,100}$/.test(req.query.t) ? req.query.t : '';
    if (!token) return gone(res);
    const key = entryKey(token);
    const held = await platform.cache.get(key);
    if (!held || held.tenantId !== tenant.id || !(held.until > Date.now())) {
      log.warn('impersonation.entry_refused', { tenant: tenant.id, reason: held ? 'wrong_business_or_late' : 'unknown' });
      return gone(res);
    }
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const opened = await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock($1, $2)', [ENTRY_LOCK, held.impersonationId]);
      const [imp] = await t.query(
        `SELECT id, operator_id, owner_user_id, expires_at FROM impersonation_sessions WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL AND expires_at > now()`,
        [tenant.id, held.impersonationId],
      );
      if (!imp) return null;
      const [used] = await t.query('SELECT 1 FROM sessions WHERE tenant_id = $1 AND impersonation_id = $2', [tenant.id, imp.id]);
      if (used) return null;
      await t.query(
        `INSERT INTO sessions (id, tenant_id, user_id, kind, expires_at, fresh_until, impersonation_id) VALUES ($1, $2, $3, 'cookie', $4, NULL, $5)`,
        [hashSessionToken(sessionToken), tenant.id, imp.owner_user_id, imp.expires_at, imp.id],
      );
      return imp;
    });
    await platform.cache.del(key);
    if (!opened) return gone(res);
    await platformAudit(db, { tenantId: tenant.id, actor: `platform:${opened.operator_id}`, action: 'impersonation.enter', target: String(opened.id), details: { impersonationId: Number(opened.id), operatorId: opened.operator_id, ownerId: opened.owner_user_id } })
      .catch((err) => reportError(err, { msg: 'impersonation.audit_failed' }));
    res.cookie('sid', sessionToken, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: Math.max(1000, new Date(opened.expires_at).getTime() - Date.now()) });
    log.info('impersonation.entered', { tenant: tenant.id, impersonationId: Number(opened.id) });
    return res.redirect(303, '/admin/');
  });
}

/**
 * Impersonation (PRD 5.10, F-42 to F-45): support opens a business as its owner, read-only unless confirmed, for at most
 * 30 minutes, with every request on the audit log under both ids. The rules are data (IMPERSONATION_BLOCKED,
 * SHOPPER_CONTACT_FIELDS and operatorRefusal in src/contracts/api/access.js) and the API router applies them; this
 * module owns the table, the console routes and the address that opens the session on the business's host.
 */
export const impersonation = {
  name: 'impersonation',
  owns: {
    migrations: [],
    tables: ['impersonation_sessions'],
    api: [],
    store: [],
    platform: PLATFORM,
    jobs: [],
  },
  repos: (db) => ({ impersonation: impersonationRepo(db) }),
  routes: (app, ctx) => mountEntry(app, ctx),
  platformRoutes: (router, ctx) => registerImpersonationRoutes(router, ctx),
};
