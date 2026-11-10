import { requirePlatformRole } from '../../auth.js';
import { platformRoutes as ROUTES } from '../../contracts/api/platform.js';
import { log } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

const LIVE_STATUSES = `('closed', 'killed')`;

const badRequest = (res, issues) => res.status(400).json({ error: issues[0]?.message ?? 'Check the details and try again.' });

/**
 * The Platform Console's pause and kill-switch routes (PRD 4.12, 4.13, 5.8), on the platform host. Anyone from Bhava's team can stop
 * everything at once; only a second person can start it again.
 */
export function registerPlatformRoutes(router, ctx) {
  const { db, repos, compliance } = ctx;
  const when = () => compliance.now();
  const adminAudit = (actor, action, details) => db.platform.query(
    'INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, $2, $3, $4::jsonb)',
    [actor, action, 'global_kill', JSON.stringify(details)],
  );

  const toSwitch = (r) => ({ key: r.key, engaged: r.engaged, reason: r.reason, engagedBy: r.engaged_by, engagedAt: r.engaged_at, releaseRequestedBy: r.release_requested_by, releaseRequestedAt: r.release_requested_at });

  const route = (id, handler) => {
    const definition = ROUTES[id];
    router[definition.method.toLowerCase()](definition.path, requirePlatformRole(...definition.platformRoles), async (req, res, next) => {
      try {
        const params = definition.params?.safeParse(req.params);
        if (params && !params.success) return res.status(404).json({ error: 'Not found.' });
        const body = definition.body?.safeParse(req.body ?? {});
        if (body && !body.success) return badRequest(res, body.error.issues);
        const query = definition.query?.safeParse(req.query);
        if (query && !query.success) return badRequest(res, query.error.issues);
        const result = await handler({ params: params?.data, body: body?.data, query: query?.data, actor: `platform:${req.platformUser.id}`, res });
        if (res.headersSent) return undefined;
        if (definition.response === null) return res.status(definition.status ?? 204).end();
        return res.status(definition.status ?? 200).json(definition.response.parse(result));
      } catch (err) {
        return next(err);
      }
    });
  };

  async function businessDetail(id) {
    const [t] = await db.platform.query('SELECT id, slug, name, status, plan, created_at, website, legal_name FROM tenants WHERE id = $1', [id]);
    if (!t) return null;
    const [s] = await db.platform.query('SELECT paused, paused_by, access_level, score FROM compliance_settings WHERE tenant_id = $1', [id]);
    const [a] = await db.platform.query(`SELECT 1 FROM ig_accounts WHERE tenant_id = $1 AND status <> 'active' LIMIT 1`, [id]);
    const [b] = await db.platform.query(`SELECT state FROM breakers WHERE tenant_id = $1 AND channel = 'instagram'`, [id]);
    return {
      id: t.id, slug: t.slug, name: t.name, status: t.status, plan: t.plan, createdAt: t.created_at, website: t.website, legalName: t.legal_name,
      paused: Boolean(s?.paused), pausedBy: s?.paused_by ?? null, accessLevel: s?.access_level ?? 'standard', reconnectNeeded: Boolean(a), breaker: b?.state ?? 'closed', score: s?.score == null ? null : Number(s.score),
    };
  }

  route('platform.switches', async () => ({ items: (await db.platform.query('SELECT * FROM platform_switches ORDER BY key')).map(toSwitch) }));

  route('platform.engageKill', async ({ body, actor }) => {
    const at = when();
    const engaged = await db.platform.query(
      `UPDATE platform_switches SET engaged = true, reason = $1, engaged_by = $2, engaged_at = $3::timestamptz, release_requested_by = '', release_requested_at = NULL, updated_at = $3::timestamptz
       WHERE key = 'global_kill' AND NOT engaged RETURNING key`,
      [body.reason, actor, at],
    );
    if (!engaged.length) return { engaged: true, affected: 0 };
    const rows = await db.platform.query(
      `INSERT INTO compliance_events (tenant_id, channel, kind, decision, reason, details, created_at)
       SELECT id, 'instagram', 'kill_switch', 'held', 'paused.global', '{}'::jsonb, $1::timestamptz FROM tenants WHERE status NOT IN ${LIVE_STATUSES} RETURNING id`,
      [at],
    );
    await adminAudit(actor, 'kill_switch.engage', { reason: body.reason, affected: rows.length });
    compliance.invalidateSwitches();
    log.warn('kill_switch.engaged', { affected: rows.length });
    return { engaged: true, affected: rows.length };
  });

  route('platform.requestRelease', async ({ body, actor, res }) => {
    const rows = await db.platform.query(
      `UPDATE platform_switches SET release_requested_by = $1, release_requested_at = $2::timestamptz, updated_at = $2::timestamptz WHERE key = 'global_kill' AND engaged RETURNING key`,
      [actor, when()],
    );
    if (!rows.length) return res.status(409).json({ error: 'The kill switch is not engaged.' });
    await adminAudit(actor, 'kill_switch.release_requested', { reason: body.reason });
    return { engaged: true, affected: 0 };
  });

  // PRD 4.12: the person who asked can't be the one who approves. Checked and changed in one statement, so a race can't get past it.
  route('platform.approveRelease', async ({ body, actor, res }) => {
    const at = when();
    const released = await db.platform.query(
      `UPDATE platform_switches SET engaged = false, reason = '', engaged_by = '', engaged_at = NULL, release_requested_by = '', release_requested_at = NULL, updated_at = $2::timestamptz
       WHERE key = 'global_kill' AND engaged AND release_requested_at IS NOT NULL AND release_requested_by <> '' AND release_requested_by <> $1 RETURNING key`,
      [actor, at],
    );
    if (!released.length) return res.status(409).json({ error: 'Release needs a request from one platform admin and approval from another.' });
    const [{ n }] = await db.platform.query(`SELECT count(*)::int AS n FROM tenants WHERE status NOT IN ${LIVE_STATUSES}`);
    await adminAudit(actor, 'kill_switch.released', { reason: body.reason });
    compliance.invalidateSwitches();
    await compliance.poke();
    return { engaged: false, affected: n };
  });

  route('platform.unfreezeActivations', async ({ body, actor }) => {
    await db.platform.query(`UPDATE platform_switches SET engaged = false, reason = '', engaged_by = '', engaged_at = NULL, updated_at = now() WHERE key = 'activations_frozen'`);
    await adminAudit(actor, 'activations.unfrozen', { reason: body.reason });
  });

  route('platform.pauseBusiness', async ({ params, body, actor, res }) => {
    const tenant = await repos.tenants.get(params.id);
    if (!tenant) return res.status(404).json({ error: 'Not found.' });
    await withTenant(tenant, async () => {
      await repos.compliance.settings();
      await db.tx(async (t) => {
        await t.query(
          `UPDATE compliance_settings SET paused = true, paused_by = $2, pause_reason = $3, paused_at = now(), pause_store = $4, updated_at = now() WHERE tenant_id = $1`,
          [tenant.id, body.billing ? 'billing' : 'ops', body.reason, body.pauseStore],
        );
        await writeAudit(t, { actor, action: 'compliance.pause', target: String(tenant.id), details: { reason: body.reason, billing: body.billing } });
      });
      await repos.compliance.record({ channel: 'instagram', kind: 'pause', decision: 'held', reason: 'paused.tenant', at: when() });
    });
    compliance.invalidateSwitches();
    return businessDetail(tenant.id);
  });

  route('platform.resumeBusiness', async ({ params, body, actor, res }) => {
    const tenant = await repos.tenants.get(params.id);
    if (!tenant) return res.status(404).json({ error: 'Not found.' });
    await withTenant(tenant, async () => {
      await repos.compliance.settings();
      await db.tx(async (t) => {
        await t.query(`UPDATE compliance_settings SET paused = false, paused_by = NULL, pause_reason = '', paused_at = NULL, pause_store = false, updated_at = now() WHERE tenant_id = $1`, [tenant.id]);
        await writeAudit(t, { actor, action: 'compliance.resume', target: String(tenant.id), details: { reason: body.reason } });
      });
    });
    compliance.invalidateSwitches();
    await compliance.poke();
    return businessDetail(tenant.id);
  });

  route('platform.unblockPerson', async ({ params, body, actor, res }) => {
    const tenant = await repos.tenants.get(params.id);
    if (!tenant) return res.status(404).json({ error: 'Not found.' });
    await withTenant(tenant, async () => {
      await repos.compliance.removeOptOut(body.channel, body.subjectHash);
      await repos.audit.record({ actor, action: 'compliance.unblock', target: body.channel, details: { reason: body.reason } });
    });
    return undefined;
  });

  route('platform.alerts', async ({ query }) => {
    const limit = query.limit;
    const rows = await db.platform.query(
      `SELECT id, kind, message, tenant_id, created_at FROM alerts WHERE audience = 'ops' AND ($1::bigint IS NULL OR id < $1::bigint) ORDER BY id DESC LIMIT $2`,
      [/^\d{1,18}$/.test(query.cursor ?? '') ? query.cursor : null, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => ({ id: String(r.id), kind: r.kind, message: r.message, tenantId: r.tenant_id, at: r.created_at }));
    return { items, nextCursor: rows.length > limit ? items.at(-1).id : null };
  });
}
