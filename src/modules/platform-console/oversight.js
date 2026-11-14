import { reportError } from '../../platform/log.js';
import { Refusal, idCursor, mountRoute, offsetCursor, platformAudit } from './mount.js';

/**
 * The console's view of what is stopped and what the team did (PRD 5.8, 5.14), and the team itself (5.5).
 *
 *   platform.pauses      every scope's state in one list: the global kill switch (with a release waiting for its second
 *                        approval), the activations freeze, each paused business, each open breaker (an account's channel)
 *                        and each paused automation, with who, why and when. Engaging and releasing are the compliance
 *                        module's routes (platform.engageKill and the rest), which refuse a pause with no reason.
 *   platform.auditLog    what Bhava's team did, newest first, everywhere or in one business.
 *   platform.team, addTeamMember, updateTeamMember   super admins only. Disabling someone or resetting their authenticator
 *                        ends their sessions at once. Nobody can demote or disable themselves, so there is always an admin.
 */

// One row shape for every scope. `actor` for a business pause is the last pause on its audit log: compliance_settings keeps
// only who in kind (owner, ops, billing).
const PAUSES_SQL = `
  SELECT * FROM (
    SELECT CASE s.key WHEN 'global_kill' THEN 'global' ELSE 'activations' END AS scope, NULL::integer AS tenant_id, '' AS tenant_name, '' AS target,
           s.engaged, s.engaged_by AS actor, s.reason, s.engaged_at AS at,
           CASE WHEN s.engaged_by = 'system' THEN 'system' ELSE 'platform' END AS by, false AS pause_store,
           s.release_requested_by, s.release_requested_at
      FROM platform_switches s
    UNION ALL
    SELECT 'business', c.tenant_id, t.name, '', true,
           COALESCE((SELECT a.actor FROM audit_log a WHERE a.tenant_id = c.tenant_id AND a.action = 'compliance.pause' ORDER BY a.id DESC LIMIT 1), c.paused_by),
           c.pause_reason, c.paused_at,
           CASE c.paused_by WHEN 'owner' THEN 'owner' WHEN 'billing' THEN 'system' ELSE 'platform' END, c.pause_store, '', NULL::timestamptz
      FROM compliance_settings c JOIN tenants t ON t.id = c.tenant_id
     WHERE c.paused
    UNION ALL
    SELECT 'account', b.tenant_id, t.name, b.channel, true, 'system', b.trip_reason, b.opened_at, 'system', false, '', NULL::timestamptz
      FROM breakers b JOIN tenants t ON t.id = b.tenant_id
     WHERE b.state <> 'closed'
    UNION ALL
    SELECT 'automation', a.tenant_id, t.name, a.id::text, true, CASE WHEN a.paused_reason = '' THEN 'owner' ELSE 'system' END, a.paused_reason, a.updated_at,
           CASE WHEN a.paused_reason = '' THEN 'owner' ELSE 'system' END, false, '', NULL::timestamptz
      FROM automations a JOIN tenants t ON t.id = a.tenant_id
     WHERE a.state = 'paused'
  ) p
  WHERE ($1::text IS NULL OR p.scope = $1) AND ($2::integer IS NULL OR p.tenant_id = $2) AND ($3::boolean IS NULL OR p.engaged = $3)
  ORDER BY p.engaged DESC, CASE p.scope WHEN 'global' THEN 0 WHEN 'activations' THEN 1 WHEN 'business' THEN 2 WHEN 'account' THEN 3 ELSE 4 END,
           p.at DESC NULLS LAST, p.tenant_id, p.target
  LIMIT $4 OFFSET $5`;

const toPause = (r) => ({
  scope: r.scope,
  tenantId: r.tenant_id === null ? null : Number(r.tenant_id),
  tenantName: r.tenant_name ?? '',
  target: r.target ?? '',
  engaged: Boolean(r.engaged),
  actor: r.actor ?? '',
  reason: r.reason ?? '',
  at: r.at ?? null,
  by: r.by,
  pauseStore: Boolean(r.pause_store),
  releasePending: r.release_requested_at ? { requestedBy: r.release_requested_by, requestedAt: r.release_requested_at } : null,
});

const toMember = (r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, totpEnrolled: Boolean(r.totp_enrolled_at), disabled: Boolean(r.disabled_at), createdAt: r.created_at });
const MEMBER = 'id, email, name, role, totp_enrolled_at, disabled_at, created_at';

export function registerOversight(router, ctx) {
  const { db } = ctx;
  const pdb = db.platform ?? db;

  mountRoute(router, 'platform.pauses', async ({ query }) => {
    const offset = offsetCursor.read(query.cursor);
    const engaged = query.engaged === undefined ? null : query.engaged === 'true';
    const rows = await pdb.query(PAUSES_SQL, [query.scope ?? null, query.tenantId ? Number(query.tenantId) : null, engaged, query.limit + 1, offset]);
    return { items: rows.slice(0, query.limit).map(toPause), nextCursor: rows.length > query.limit ? `o${offset + query.limit}` : null };
  });

  mountRoute(router, 'platform.auditLog', async ({ query }) => {
    const rows = await pdb.query(
      `SELECT id, tenant_id, actor, action, target, details, created_at FROM audit_log
        WHERE actor LIKE 'platform:%' AND ($1::integer IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR actor = $2) AND ($3::text IS NULL OR action = $3)
          AND ($4::bigint IS NULL OR id < $4)
        ORDER BY id DESC LIMIT $5`,
      [query.tenantId ? Number(query.tenantId) : null, query.actor || null, query.action || null, idCursor(query.cursor), query.limit + 1],
    );
    const items = rows.slice(0, query.limit).map((r) => ({ id: Number(r.id), tenantId: r.tenant_id === null ? null : Number(r.tenant_id), actor: r.actor, action: r.action, target: r.target, details: r.details ?? {}, at: r.created_at }));
    return { items, nextCursor: rows.length > query.limit ? String(items.at(-1).id) : null };
  });

  mountRoute(router, 'platform.team', async () => ({ items: (await pdb.query(`SELECT ${MEMBER} FROM platform_users ORDER BY created_at, id`)).map(toMember) }));

  mountRoute(router, 'platform.addTeamMember', async ({ body, actor }) => {
    const [row] = await pdb.query(`INSERT INTO platform_users (email, name, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING ${MEMBER}`, [body.email, body.name, body.role]);
    if (!row) throw new Refusal(409, 'Someone on the team already has this email.', 'conflict');
    await platformAudit(db, { actor, action: 'platform.team_add', target: String(row.id), details: { role: body.role } });
    return toMember(row);
  });

  mountRoute(router, 'platform.updateTeamMember', async ({ params, body, user, actor }) => {
    const [before] = await pdb.query(`SELECT ${MEMBER} FROM platform_users WHERE id = $1`, [params.id]);
    if (!before) throw new Refusal(404, 'Not found.');
    if (before.id === user.id && ((body.role && body.role !== before.role) || body.disabled === true)) throw new Refusal(409, 'You can’t change your own role or turn off your own access. Ask another admin.', 'conflict');
    const row = await pdb.tx(async (t) => {
      const [updated] = await t.query(
        `UPDATE platform_users SET role = COALESCE($2, role),
                disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN COALESCE(disabled_at, now()) ELSE NULL END,
                totp_secret_enc = CASE WHEN $4 THEN '' ELSE totp_secret_enc END,
                totp_enrolled_at = CASE WHEN $4 THEN NULL ELSE totp_enrolled_at END
          WHERE id = $1 RETURNING ${MEMBER}`,
        [params.id, body.role ?? null, body.disabled ?? null, Boolean(body.resetTotp)],
      );
      if (body.resetTotp) await t.query('DELETE FROM platform_recovery_codes WHERE platform_user_id = $1', [params.id]);
      // Losing access, a role or the authenticator ends every session now; the next request is a sign-in.
      if (body.disabled || body.resetTotp || (body.role && body.role !== before.role)) await t.query('UPDATE platform_sessions SET revoked_at = now() WHERE platform_user_id = $1 AND revoked_at IS NULL', [params.id]);
      return updated;
    });
    await platformAudit(db, {
      actor,
      action: 'platform.team_update',
      target: String(row.id),
      details: { reason: body.reason, ...(body.role ? { role: body.role, wasRole: before.role } : {}), ...(body.disabled !== undefined ? { disabled: body.disabled } : {}), ...(body.resetTotp ? { resetTotp: true } : {}) },
    });
    return toMember(row);
  });
}

/**
 * Every change a platform user makes through the console, and every look at one business, is on the audit log (PRD 5.5,
 * 5.14): who (their id), when, what (method and route), the answer's status, refusals included, and the reason they gave
 * when the route takes one. A route under /tenants/:id is filed under that business, so its owner sees it on their audit
 * screen. Lists across businesses are not recorded when only read, or the log would be noise. Routes write their own, more
 * detailed rows too; this one guarantees nothing is left out.
 */
export function auditConsoleWrites(db) {
  return (req, res, next) => {
    if (!req.platformUser) return next();
    const tenant = /^\/tenants\/(\d{1,9})(?:\/|$)/.exec(req.path)?.[1];
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (reading && !tenant) return next();
    const user = req.platformUser;
    res.on('finish', () => {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined;
      const action = reading ? 'platform.view' : 'platform.request';
      const details = { status: res.statusCode, role: user.role, ...(tenant ? { tenantId: Number(tenant) } : {}), ...(reason ? { reason } : {}) };
      // Filed under the business only when it exists, so a row about a mistyped id never lands on a business made later with it.
      (db.platform ?? db)
        .query(
          `INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES ((SELECT id FROM tenants WHERE id = $1), $2, $3, $4, $5)`,
          [tenant ? Number(tenant) : null, `platform:${user.id}`, action, `${req.method} ${req.route?.path ?? req.path}`.slice(0, 200), JSON.stringify(details)],
        )
        .catch((err) => reportError(err, { msg: 'platform.audit_failed', action }));
    });
    next();
  };
}
