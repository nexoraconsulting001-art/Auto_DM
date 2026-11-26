// Shared by the reports tests: the whole app on a fresh database, businesses with their own owners and addresses, a clock the test sets for
// reports, and the module's own job handlers, drained by the test so a run is deterministic.
import crypto from 'node:crypto';
import { MODULES } from '../../../src/modules/index.js';
import { QUEUE_TICK, jobHandlers } from '../../../src/modules/reports/jobs.js';
import { createPlatform } from '../../../src/platform/index.js';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { startApp } from '../../helpers.js';
import { NEUTRAL, addBusiness, api, hit, need, nextPhone, signIn } from '../../p0/spec-p0/support.js';

export { NEUTRAL, api, captureLogs, hit, need, requestId } from '../../p0/spec-p0/support.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const IST_MS = 5.5 * HOUR;

/** A moment on the business's clock, for India: istAt('2026-11-09', 9, 5) is Monday 09:05 in India. */
export const istAt = (day, hour, minute = 0) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR + minute * 60_000 - IST_MS;

let serial = 0;
export const unique = () => `${process.pid}${++serial}${crypto.randomInt(1000)}`;

export async function openWorld(t, { at = Date.now() } = {}) {
  const clock = { t: at };
  const overrides = { platformDomain: NEUTRAL, publicBaseUrl: '', defaultTenant: '', reportsNow: () => clock.t };
  const app = await startApp({ overrides });
  t.after(() => app.close());
  // The worker's side: the same database, its own drivers, as src/worker.js builds them, from the app's own config, so on the CI production profile
  // (STORAGE_DRIVER, QUEUE_DRIVER, ... from the environment) the worker writes files to the store and jobs to the queue the web app reads.
  const config = { ...app.config };
  const drivers = createPlatform(config, { db: app.db });
  const repos = createRepos(app.db, { storage: drivers.storage, secrets: drivers.secrets, modules: MODULES });
  const jobCtx = { db: app.db, repos, platform: drivers, config, ig: app.ig, modules: MODULES };
  const handlers = jobHandlers(jobCtx);

  // The pg queue can be drained by hand. A queue that has consumers of its own (BullMQ on the CI production profile) has no drain(): its handlers are
  // registered once, as src/worker.js does, and a run waits until this module's queues hold nothing queued, delayed or running.
  const names = Object.keys(handlers).filter((name) => name !== QUEUE_TICK);
  let consuming = false;
  async function waitIdle() {
    const stop = Date.now() + 60_000;
    for (let quiet = 0; quiet < 3 && Date.now() < stop;) {
      const stats = await drivers.queue.stats();
      const busy = names.some((name) => (stats[name]?.queued ?? 0) + (stats[name]?.delayed ?? 0) + (stats[name]?.running ?? 0) > 0);
      quiet = busy ? 0 : quiet + 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Runs what the module's minute tick finds due, then every queued job of this module, until nothing is left. */
  async function runJobs({ tick = true } = {}) {
    if (tick) await handlers[QUEUE_TICK]();
    if (typeof drivers.queue.drain !== 'function') {
      if (!consuming) {
        for (const name of names) drivers.queue.work(name, handlers[name]);
        consuming = true;
        t.after(() => drivers.queue.close?.());
      }
      await waitIdle();
      return;
    }
    for (let round = 0; round < 10; round++) {
      let ran = 0;
      for (const name of names) ran += await drivers.queue.drain(name, handlers[name]);
      if (!ran) return;
    }
  }

  async function addShop({ plan = 't3', timeZone = 'Asia/Kolkata', name } = {}) {
    const slug = `r${unique()}`;
    const business = await addBusiness(app, { slug, name: name ?? `Shop ${slug}`, plan });
    await app.db.platform.query('UPDATE tenants SET timezone = $2 WHERE id = $1', [business.tenant.id, timeZone]);
    const bound = bindTenant(repos, business.tenant);
    const token = await signIn(app, business);
    const tenantId = business.tenant.id;
    const shop = {
      ...business, tenantId, timeZone, repos: bound, token,
      inside: (fn) => withTenant(business.tenant, fn),
      sql: (text, params = []) => app.db.platform.query(text, params),
      call: (path, options = {}, who = token) => api(app, business, who, path, options),
      json: async (path, options = {}, status = 200, who = token) => need(await api(app, business, who, path, options), status, `${options.method ?? 'GET'} ${path}`).json(),
      file: (url, who = token) => hit(app, url, { host: business.host, ...(who ? { token: who } : {}) }),
      async addUser(role, permissions = [], extra = {}) {
        const who = { phone: nextPhone(), password: `${role}-pass-123` };
        const user = await bound.users.create({ name: `${role} person`, role, ...who });
        if (permissions.length) await bound.users.setPermissions(user.id, permissions);
        if (extra.email) await app.db.platform.query('UPDATE users SET email = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, user.id, extra.email]);
        return { ...who, user, token: await signIn(app, business, who) };
      },
      async accountRef(igUserId = `ig${unique()}`) {
        await app.platform.tenants.linkIgAccount(tenantId, igUserId, 'shop_ig');
        const [row] = await app.db.platform.query(`INSERT INTO analytics_accounts (tenant_id, channel, ig_user_id, collecting_since) VALUES ($1, 'instagram', $2, '2025-01-01') RETURNING id, account_id`, [tenantId, igUserId]);
        return row;
      },
      async seedMedia(ref, { mediaId = `m${unique()}`, kind = 'reel', caption = 'A post', latest = {}, postedAt = new Date(Date.now() - 2 * DAY), storyFinalState = 'open' } = {}) {
        await app.db.platform.query(
          `INSERT INTO insight_media (tenant_id, account_ref, media_id, kind, caption, posted_at, latest, story_final_state) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [tenantId, ref.id, mediaId, kind, caption, postedAt, JSON.stringify(latest), storyFinalState],
        );
        return mediaId;
      },
      write: (store, rows) => withTenant(business.tenant, () => drivers.analytics.rollups.write(store, rows)),
      deliveries: (where = 'true', params = []) => app.db.platform.query(`SELECT * FROM report_deliveries WHERE tenant_id = $1 AND (${where}) ORDER BY id`, [tenantId, ...params]),
      runs: (kind) => app.db.platform.query(`SELECT *, to_char(period_start, 'YYYY-MM-DD') AS start FROM report_runs WHERE tenant_id = $1 AND kind = $2 ORDER BY id`, [tenantId, kind]),
      audit: (pattern) => app.db.platform.query('SELECT * FROM audit_log WHERE tenant_id = $1 AND action ~* $2 ORDER BY id', [tenantId, pattern]),
    };
    return shop;
  }

  return { app, clock, drivers, repos, jobCtx, runJobs, addShop, db: app.db };
}

/** A CSV as rows of cells, with quoted fields that hold commas, quotes and new lines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
