import { OPS_PLATFORM_OWNERS } from '../../contracts/api/platform-ops.js';
import { CHECK_EVERY_MS, CHECK_TIMEOUT_MS, HEALTH_CHECKS, HEALTH_CHECK_NAMES, compareHealth, withinTimeout, worstOf } from '../../contracts/health.js';
import { NOTIFY_EVENTS } from '../../contracts/notifications.js';
import { createInstagram } from '../../instagram.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { Refusal, mountRoute, offsetCursor } from '../platform-console/mount.js';
import { CHECKS, accountFacts } from './checks.js';

const PLATFORM = OPS_PLATFORM_OWNERS['tenant-health'];
const JOB = 'tenant-health.checks';
const JOB_BATCH = 20;

/** What the owner is told when a check of their own keys turns bad (F-41): in the alerts list, and as a notification. */
const NOTICES = Object.freeze({
  'reconnect.payments': { link: '/settings/payment', message: 'Your own payment account stopped accepting the connection, so online payments may fail. Reconnect it in Settings > Payments.' },
  'reconnect.shipping': { link: '/settings/shipping', message: 'Your own courier account stopped accepting the login saved for it. Update your Shiprocket API login in Settings > Shipping.' },
});

/**
 * The health service (PRD 5.9, F-39 to F-41). One business at a time:
 *
 *   run(tenant)    runs the checks that have not run in the last 10 minutes (CHECK_EVERY_MS), all at once, each stopped at
 *                  10 s (withinTimeout records `unreachable`), and answers every check. Which checks are due is claimed in one
 *                  statement (last_ran_at moves forward only on a row that is due), so however often the page is opened, and
 *                  from however many servers, a check runs at most once per 10 minutes per business. A check of the owner's
 *                  own keys that turns bad tells the owner once; it is not repeated while it stays bad.
 *   view(tenant)   the stored answers, never a call to anyone.
 *   list()         every business that is not closed, worst first (compareHealth), from the stored answers.
 *
 * Checks of the owner's own keys (`ownKeysOnly`) exist only for a business on its own payment or courier account.
 */
export function createHealth(ctx) {
  const { db, config, platform, repos, notify } = ctx;
  const pdb = db.platform ?? db;
  // Its own client, so the contract's 10 s decides when the Graph API is unreachable rather than the adapter's default.
  const ig = createInstagram({ ...config, metaTimeoutMs: CHECK_TIMEOUT_MS + 2_000 });

  const TENANTS = `SELECT t.id, t.slug, t.name, t.status,
      (SELECT min(h.score) FROM account_health h WHERE h.tenant_id = t.id) AS score,
      COALESCE((SELECT p.mode FROM payment_settings p WHERE p.tenant_id = t.id), 'managed') AS pay_mode,
      COALESCE((SELECT s.mode FROM shipping_settings s WHERE s.tenant_id = t.id), 'managed') AS ship_mode
    FROM tenants t`;

  const applicable = (t) => HEALTH_CHECK_NAMES.filter((name) => {
    if (!HEALTH_CHECKS[name].ownKeysOnly) return true;
    return name === 'keys.payments' ? t.pay_mode === 'own' : name === 'keys.shipping' ? t.ship_mode === 'own' : false;
  });

  const tenantRow = async (id) => (await pdb.query(`${TENANTS} WHERE t.id = $1`, [id]))[0] ?? null;

  function shape(t, rows) {
    const names = applicable(t);
    const byName = new Map(rows.map((r) => [r.check_name, r]));
    const checks = names.map((name) => {
      const row = byName.get(name);
      return row
        ? { check: name, label: HEALTH_CHECKS[name].label, status: row.status, lastRanAt: row.last_ran_at, detail: row.detail ?? {} }
        : { check: name, label: HEALTH_CHECKS[name].label, status: 'warn', lastRanAt: null, detail: { reason: 'not_run' } };
    });
    return { tenantId: t.id, tenantName: t.name, worst: worstOf(checks.map((c) => c.status)), score: t.score === null || t.score === undefined ? null : Number(t.score), checks };
  }

  async function view(t) {
    return shape(t, await pdb.query('SELECT check_name, status, last_ran_at, detail FROM tenant_health_checks WHERE tenant_id = $1', [t.id]));
  }

  async function tellOwner(t, check) {
    const kind = HEALTH_CHECKS[check].notifies;
    const notice = NOTICES[kind];
    if (!kind || !notice) return;
    const stamp = Date.now();
    await withTenant(t, async () => {
      await repos.alerts.raise({ kind, audience: 'owner', severity: 'critical', message: notice.message, target: check, dedupeKey: `${kind}:${stamp}` });
      if (NOTIFY_EVENTS[kind]) {
        await notify.emit({ event: kind, tenantId: t.id, key: `health:${check}:${stamp}`, link: notice.link });
        return;
      }
      // The notifications contract has no row for this kind yet (see the track's report): the outbox row is written as emit()
      // would write it, and the service hands it out once the kind is added.
      await pdb.query(
        `INSERT INTO notification_events (tenant_id, kind, event_key, audience, data, link) VALUES ($1, $2, $3, '"owner"'::jsonb, '{}'::jsonb, $4)
         ON CONFLICT DO NOTHING`,
        [t.id, kind, `health:${check}:${stamp}`, notice.link],
      );
    });
    log.info('tenant_health.owner_told', { tenant: t.id, check });
  }

  async function run(t) {
    const names = applicable(t);
    const before = new Map((await pdb.query('SELECT check_name, status FROM tenant_health_checks WHERE tenant_id = $1', [t.id])).map((r) => [r.check_name, r.status]));
    await pdb.query('DELETE FROM tenant_health_checks WHERE tenant_id = $1 AND NOT (check_name = ANY($2::text[]))', [t.id, names]);
    // The claim: a new row, or an old one that is due. Everything else is answered from what is stored.
    const claimed = (await pdb.query(
      `INSERT INTO tenant_health_checks (tenant_id, check_name, status, last_ran_at, detail)
       SELECT $1, n, 'unreachable', now(), '{"reason":"running"}'::jsonb FROM unnest($2::text[]) AS n
       ON CONFLICT (tenant_id, check_name) DO UPDATE SET last_ran_at = now()
         WHERE tenant_health_checks.last_ran_at <= now() - make_interval(secs => $3::float)
       RETURNING check_name`,
      [t.id, names, CHECK_EVERY_MS / 1000],
    )).map((r) => r.check_name);
    if (claimed.length) {
      const results = await withTenant(t, async () => {
        const facts = await accountFacts(pdb, t.id);
        const env = { ctx, pdb, tenant: t, platform, repos, ig, facts };
        return Promise.all(claimed.map((name) => withinTimeout(() => CHECKS[name](env))));
      });
      for (const [i, name] of claimed.entries()) {
        const result = results[i] ?? {};
        const status = ['ok', 'warn', 'bad', 'unreachable'].includes(result.status) ? result.status : 'unreachable';
        await pdb.query('UPDATE tenant_health_checks SET status = $3, detail = $4::jsonb WHERE tenant_id = $1 AND check_name = $2', [t.id, name, status, JSON.stringify(result.detail ?? {})]);
        if (status === 'bad' && before.get(name) !== 'bad' && HEALTH_CHECKS[name].notifies) await tellOwner(t, name).catch((err) => reportError(err, { msg: 'tenant_health.notice_failed', check: name }));
      }
      log.info('tenant_health.ran', { tenant: t.id, ran: claimed.length });
    }
    return view(t);
  }

  async function list() {
    const tenants = await pdb.query(`${TENANTS} WHERE t.status <> 'closed'`);
    const rows = await pdb.query(`SELECT h.tenant_id, h.check_name, h.status, h.last_ran_at, h.detail FROM tenant_health_checks h JOIN tenants t ON t.id = h.tenant_id WHERE t.status <> 'closed'`);
    const byTenant = new Map();
    for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
    return tenants.map((t) => shape(t, byTenant.get(t.id) ?? [])).sort((a, b) => compareHealth({ worst: a.worst, score: a.score, name: a.tenantName }, { worst: b.worst, score: b.score, name: b.tenantName }));
  }

  /** The worker's sweep: businesses whose oldest check is due, a few at a time. */
  async function sweep() {
    const due = await pdb.query(
      `SELECT t.id FROM tenants t LEFT JOIN tenant_health_checks h ON h.tenant_id = t.id
        WHERE t.status <> 'closed' GROUP BY t.id
       HAVING min(h.last_ran_at) IS NULL OR min(h.last_ran_at) <= now() - make_interval(secs => $1::float)
        ORDER BY min(h.last_ran_at) NULLS FIRST, t.id LIMIT $2`,
      [CHECK_EVERY_MS / 1000, JOB_BATCH],
    );
    for (const { id } of due) {
      const t = await tenantRow(id);
      if (t) await run(t).catch((err) => reportError(err, { msg: 'tenant_health.run_failed', tenant: id }));
    }
  }

  return { run, view, list, sweep, tenantRow };
}

const built = new WeakMap();
const healthFor = (ctx) => {
  if (!built.has(ctx)) built.set(ctx, createHealth(ctx));
  return built.get(ctx);
};

export function registerHealthRoutes(router, ctx) {
  const health = () => healthFor(ctx);
  const business = async (id) => {
    const t = await health().tenantRow(id);
    if (!t) throw new Refusal(404, 'Not found.');
    return t;
  };

  mountRoute(router, 'platform.health', async ({ query }) => {
    const all = await health().list();
    const offset = offsetCursor.read(query.cursor);
    return { items: all.slice(offset, offset + query.limit), nextCursor: offsetCursor.next(offset, query.limit, all.length) };
  });
  mountRoute(router, 'platform.businessHealth', async ({ params }) => health().view(await business(params.id)));
  mountRoute(router, 'platform.runHealth', async ({ params }) => health().run(await business(params.id)));
}

/**
 * The tenant health console (PRD 5.9, F-39 to F-41): every business's checks in one place, worst first. The checks are
 * data in src/contracts/health.js (the Phase 2 Account Health deductions, domain and TLS, and own provider keys); this
 * module supplies one function per check (checks.js), runs each inside withinTimeout (10 s, recorded as unreachable) at
 * most every 10 minutes per business, and keeps the last answer in tenant_health_checks. It sets no thresholds of its own.
 */
export const tenantHealth = {
  name: 'tenant-health',
  owns: {
    migrations: [],
    tables: ['tenant_health_checks'],
    api: [],
    store: [],
    platform: PLATFORM,
    jobs: [JOB],
  },
  platformRoutes: (router, ctx) => registerHealthRoutes(router, ctx),

  /** The sweep runs every 10 minutes, the first one 10 minutes after the worker starts. */
  jobs(ctx) {
    let next = Date.now() + CHECK_EVERY_MS;
    let running = false;
    return async function schedule() {
      if (running || Date.now() < next) return;
      running = true;
      next = Date.now() + CHECK_EVERY_MS;
      try {
        await healthFor(ctx).sweep();
      } catch (err) {
        reportError(err, { msg: 'tenant_health.sweep_failed', job: JOB });
      } finally {
        running = false;
      }
    };
  },
};
