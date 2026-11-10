// Shared by the Reach Guard tests: a business with one connected account, a clock the test controls, and helpers to fill the cache the way the insights poller does.
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { createReachGuard } from '../../../src/modules/reach-guard/service.js';
import { addDays, lastSettledDay } from '../../../src/modules/reach-guard/rules.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const IG = 'IG-A';
export const ALL_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights'];

/** The noon on which `day` is the newest settled day. */
export const noonSettling = (day) => Date.parse(`${addDays(day, 2)}T12:00:00.000Z`);

export const START = noonSettling('2026-11-08');

export async function connectAccount(db, repos, tenant, igUserId, { scopes = ALL_SCOPES, expiresAt = null, connectedAt = new Date(START - 30 * DAY) } = {}) {
  await repos.tenants.linkIgAccount(tenant.id, igUserId, 'shop');
  await withTenant(tenant, () => repos.igAccounts.setToken(igUserId, `token-${igUserId}`));
  await db.platform.query('UPDATE ig_accounts SET granted_scopes = $2, token_expires_at = $3::timestamptz, connected_at = $4::timestamptz WHERE ig_user_id = $1', [igUserId, scopes, expiresAt, connectedAt]);
}

export async function addAnalyticsAccount(db, tenant, igUserId) {
  const [row] = await db.platform.query(`INSERT INTO analytics_accounts (tenant_id, channel, ig_user_id, collecting_since) VALUES ($1, 'instagram', $2, '2025-01-01') RETURNING id`, [tenant.id, igUserId]);
  return row.id;
}

/** Stores daily reach. values is oldest first and ends on endDay; null is an empty data set. */
export async function seedDays(db, tenant, ref, endDay, values, metric = 'reach') {
  for (let i = 0; i < values.length; i++) {
    await db.platform.query(
      `INSERT INTO insight_daily (tenant_id, account_ref, day, metric, value) VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (tenant_id, account_ref, day, metric, breakdown, breakdown_value) DO UPDATE SET value = EXCLUDED.value`,
      [tenant.id, ref, addDays(endDay, i - values.length + 1), metric, values[i]],
    );
  }
}

let mediaSerial = 0;

/** Stores media with one snapshot each at about 24h. posted is oldest first. */
export async function seedMedia(db, tenant, ref, items) {
  for (const { kind = 'reel', postedAt, reach, ageMinutes = 1440, belowThreshold = false, metrics } of items) {
    const [m] = await db.platform.query(
      `INSERT INTO insight_media (tenant_id, account_ref, media_id, kind, posted_at) VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id`,
      [tenant.id, ref, `m${++mediaSerial}`, kind, new Date(postedAt)],
    );
    await db.platform.query(
      `INSERT INTO insight_snapshots (tenant_id, media_ref, slot, age_minutes, metrics, below_threshold) VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb, $6)`,
      [tenant.id, m.id, new Date(+new Date(postedAt) + ageMinutes * 60_000), ageMinutes, JSON.stringify(metrics ?? (reach === null ? {} : { reach })), belowThreshold],
    );
  }
}

/** n media of the same reach, a day apart, ending well before the test's dates. */
export const normalMedia = (n, reach = 1000, kind = 'reel', end = START - 40 * DAY) => Array.from({ length: n }, (_, i) => ({ kind, reach, postedAt: end - (n - i) * DAY }));

export async function world({ at = START, scopes } = {}) {
  const base = await setup();
  const clock = { t: at };
  const compliance = createCompliance({ db: base.db, repos: base.platform, ig: {}, config: { complianceNow: () => clock.t }, platform: {} });
  const guard = createReachGuard({ db: base.db, repos: base.platform, compliance });
  await connectAccount(base.db, base.platform, base.tenant, IG, { scopes });
  const ref = await addAnalyticsAccount(base.db, base.tenant, IG);
  const inside = (fn) => withTenant(base.tenant, fn);
  const account = () => inside(() => base.platform.reachGuard.account(ref));
  return {
    ...base, clock, compliance, guard, ref, inside, account,
    evaluate: async () => inside(async () => guard.evaluate(await base.platform.reachGuard.account(ref))),
    status: () => inside(() => guard.status()),
    health: () => inside(async () => guard.computeHealth(await base.platform.reachGuard.account(ref))),
    slow: () => inside(() => compliance.slowMode.status('instagram', IG)),
    tripRows: () => base.db.platform.query('SELECT * FROM reach_guard_trips WHERE tenant_id = $1 ORDER BY id', [base.tenant.id]),
    alertRows: () => base.db.platform.query(`SELECT * FROM alerts WHERE tenant_id = $1 AND kind LIKE 'reach_guard%' ORDER BY id`, [base.tenant.id]),
    reasonRows: () => base.db.platform.query(`SELECT * FROM compliance_events WHERE tenant_id = $1 AND reason = 'rate.slow_mode' ORDER BY id`, [base.tenant.id]),
  };
}

/** A settled account with 28 normal days ending on endDay, and enough media to be out of Learning. */
export async function establish(w, endDay = '2026-11-05', reach = 10_000) {
  await seedDays(w.db, w.tenant, w.ref, endDay, Array(28).fill(reach));
  await seedMedia(w.db, w.tenant, w.ref, normalMedia(6));
}

export const at = (w, endDay) => { w.clock.t = noonSettling(endDay); };

/** Moves on to the day after `day` and stores its reach, as it settles. */
export async function settle(w, day, reach) {
  await seedDays(w.db, w.tenant, w.ref, day, [reach]);
  at(w, day);
  return w.evaluate();
}

export { addDays, lastSettledDay };
