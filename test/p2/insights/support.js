// What the insights tests share: one database per file, a simulator per test, one clock for both, and businesses that are connected the way a real one is.
import { createMetaAdapters } from '../../../src/adapters/meta/index.js';
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { createInsightsPoller } from '../../../src/modules/insights/poller.js';
import { createAnalytics } from '../../../src/platform/analytics.js';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { setup } from '../../helpers.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const NOW = Date.parse('2026-11-10T12:00:00.000Z');
export const dayBack = (n, from = NOW) => new Date(from - n * DAY).toISOString().slice(0, 10);

let shared = null;
let counter = 0;

/** The file's database, and a simulator on a frozen clock that this test owns. Polls left by earlier tests are stopped, because a tick looks across businesses. */
export async function world(t, { at = NOW, limits } = {}) {
  const base = await (shared ??= setup());
  await base.db.platform.query('UPDATE insight_polls SET stopped_at = now() WHERE stopped_at IS NULL');

  const sim = createMeta(limits ? { limits } : {});
  await sim.start();
  t.after(() => sim.close());
  await sim.post('/clock', { now: at, freeze: true });

  const clock = { t: at };
  const config = { complianceNow: () => clock.t, complianceInline: false };
  const meta = createMetaAdapters({ graphBaseUrl: sim.url, metaTimeoutMs: 1500 });
  const compliance = createCompliance({ db: base.db, repos: base.platform, ig: {}, meta, config, platform: { metrics: { inc() {} } } });
  const drivers = { analytics: createAnalytics({ analyticsDriver: 'pg' }, { db: base.db }) };
  const poller = createInsightsPoller({ db: base.db, repos: base.platform, meta, compliance, platform: drivers, config });

  const advance = async (ms) => {
    clock.t += ms;
    await sim.post('/clock', { advanceMs: ms });
  };

  async function business({ followers = 5000, seed = {} } = {}) {
    const n = ++counter;
    const tenant = await base.platform.tenants.create({ slug: `in-${process.pid}-${n}`, name: `Shop ${n}` });
    const igUserId = `IG${process.pid}${n}`;
    await base.platform.tenants.linkIgAccount(tenant.id, igUserId, `shop${n}`);
    const { token } = await sim.post('/accounts', { igUserId, username: `shop${n}`, followersCount: followers, ...seed });
    const repos = bindTenant(base.platform, tenant);
    await repos.igAccounts.setToken(igUserId, token);
    const inTenant = (fn) => withTenant(tenant, fn);
    const q = (sql, params = []) => base.db.platform.query(sql, params);
    return {
      tenant,
      igUserId,
      token,
      repos,
      inTenant,
      q,
      polls: () => q('SELECT * FROM insight_polls WHERE tenant_id = $1 ORDER BY id', [tenant.id]),
      poll: async (job, mediaId) => {
        const rows = mediaId
          ? await q('SELECT p.* FROM insight_polls p JOIN insight_media m ON m.tenant_id = p.tenant_id AND m.id = p.media_ref WHERE p.tenant_id = $1 AND p.job = $2 AND m.media_id = $3', [tenant.id, job, mediaId])
          : await q('SELECT * FROM insight_polls WHERE tenant_id = $1 AND job = $2', [tenant.id, job]);
        return rows[0];
      },
      media: async (mediaId) => (await q('SELECT * FROM insight_media WHERE tenant_id = $1 AND media_id = $2', [tenant.id, mediaId]))[0],
      snapshots: (mediaId) => q('SELECT s.* FROM insight_snapshots s JOIN insight_media m ON m.tenant_id = s.tenant_id AND m.id = s.media_ref WHERE s.tenant_id = $1 AND m.media_id = $2 ORDER BY s.captured_at', [tenant.id, mediaId]),
      account: async () => (await q('SELECT * FROM analytics_accounts WHERE tenant_id = $1', [tenant.id]))[0],
      daily: (metric) => q('SELECT day::text AS day, value, breakdown, breakdown_value FROM insight_daily WHERE tenant_id = $1 AND metric = $2 ORDER BY day, breakdown_value', [tenant.id, metric]),
      /** Makes one poll due now and every other poll of this business wait, so a tick runs only that. */
      only: async (job, mediaId) => {
        const later = new Date(clock.t + 365 * 86_400_000).toISOString();
        const nowIso = new Date(clock.t).toISOString();
        await q('UPDATE insight_polls SET next_due_at = $2::timestamptz WHERE tenant_id = $1 AND stopped_at IS NULL', [tenant.id, later]);
        if (mediaId) {
          await q(
            `UPDATE insight_polls p SET next_due_at = $4::timestamptz FROM insight_media m
             WHERE p.tenant_id = $1 AND p.job = $2 AND m.tenant_id = p.tenant_id AND m.id = p.media_ref AND m.media_id = $3`,
            [tenant.id, job, mediaId, nowIso],
          );
        } else {
          await q('UPDATE insight_polls SET next_due_at = $3::timestamptz WHERE tenant_id = $1 AND job = $2 AND stopped_at IS NULL', [tenant.id, job, nowIso]);
        }
      },
    };
  }

  return { ...base, sim, clock, advance, poller, compliance, drivers, business, tick: () => poller.tick(), enrol: () => poller.enrolNew(clock.t) };
}

export const closeShared = async () => {
  if (shared) await (await shared).db.close();
  shared = null;
};

/** The requests the simulator saw on insights paths, as query objects. */
export const insightCalls = async (sim) => (await sim.calls({ path: '*/insights' })).map((c) => c.query);
