import { log } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { writeSample } from './fill.js';
import { DEMO_BUSINESS, SAMPLE_VERSION, buildSample, dayOfMs, isDay, sampleDigest } from './sample.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A sample this many days old is rebuilt for today, once nobody is using the demo business. */
export const REFRESH_AFTER_DAYS = 7;
/** Nobody is using the demo business when no session of it began and the review login was not used for this long. */
export const IDLE_MS = 2 * HOUR;

/**
 * Makes, refreshes and describes the demo business (PRD 10.6, P-24, P-25). It is found by tenants.is_demo and nothing
 * else. A reset removes the whole business and writes it again from buildSample(), so two resets for the same day
 * leave the same rows (only ids and keyed hashes differ), and anything a reviewer added is gone. Removing it signs out
 * whoever was in it; the review login opens the new one at the next sign-in.
 *
 * `db` is the app's database ({ platform } is used: a demo business spans tenants, review_logins and demo_samples);
 * `repos.compliance.subjectHash` hashes each sample person as the engine would.
 */
export function demoTenantService({ db, repos, config = {}, now = () => Date.now() }) {
  const platform = db.platform ?? db;
  const today = () => dayOfMs(now());

  async function find() {
    const [row] = await platform.query(
      `SELECT t.id, t.slug, t.name, s.version, s.anchor_day::text AS anchor_day, s.digest, s.filled_at
       FROM tenants t LEFT JOIN demo_samples s ON s.tenant_id = t.id WHERE t.is_demo`,
    );
    return row ?? null;
  }

  const describe = (row) => row
    ? { exists: true, tenantId: row.id, slug: row.slug, version: row.version ?? null, anchorDay: row.anchor_day ?? null, digest: row.digest ?? null,
      filledAt: row.filled_at ?? null, current: row.version === SAMPLE_VERSION }
    : { exists: false };

  /** Points the review login at the demo business. Migration 540 refuses any other business for it. */
  const linkReviewLogin = (id) => platform.query('UPDATE review_logins SET tenant_id = $1, updated_at = now() WHERE tenant_id IS DISTINCT FROM $1', [id]);

  async function create() {
    const [taken] = await platform.query('SELECT 1 FROM tenants WHERE slug = $1', [DEMO_BUSINESS.slug]);
    if (taken) throw new Error(`Another business already uses the address name "${DEMO_BUSINESS.slug}"; the demo business needs it.`);
    const [row] = await platform.query(
      `INSERT INTO tenants (slug, name, legal_name, plan, is_demo) VALUES ($1, $2, $3, $4, true) RETURNING id, slug, name`,
      [DEMO_BUSINESS.slug, DEMO_BUSINESS.name, DEMO_BUSINESS.legalName, DEMO_BUSINESS.plan],
    );
    return row;
  }

  async function fill(tenant, anchorDay) {
    const sample = buildSample({ anchorDay, secret: config.sessionSecret ?? '' });
    const digest = sampleDigest(sample);
    const counts = await withTenant(tenant, async () => {
      // The keyed hashes come first: the compliance repo makes the business's settings (paused for good, migration 540).
      const hashes = new Map();
      for (const thread of sample.threads) hashes.set(thread.person, await repos.compliance.subjectHash('instagram', thread.person));
      // As the owner of the tables: a sample's past is written in, timelines and events included, which no business may do.
      return platform.tx((t) => writeSample(t, sample, { subjectHash: (_channel, person) => hashes.get(person) }));
    });
    await platform.query(
      `INSERT INTO demo_samples (tenant_id, version, anchor_day, digest) VALUES ($1, $2, $3::date, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET version = EXCLUDED.version, anchor_day = EXCLUDED.anchor_day, digest = EXCLUDED.digest, filled_at = now()`,
      [tenant.id, sample.version, anchorDay, digest],
    );
    return { digest, counts };
  }

  /** Removes the demo business, if there is one. Every row it owns goes with it. */
  async function remove() {
    const rows = await platform.query('DELETE FROM tenants WHERE is_demo RETURNING id');
    if (rows.length) log.info('demo_tenant.removed', { tenantId: rows[0].id });
    return rows.length > 0;
  }

  /** Writes the demo business afresh for `anchorDay` (today by default). */
  async function reset({ anchorDay = today() } = {}) {
    if (!isDay(anchorDay)) throw new Error('The day must be written YYYY-MM-DD.');
    await remove();
    const tenant = await create();
    let filled;
    try {
      filled = await fill(tenant, anchorDay);
    } catch (err) {
      await platform.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
      throw err;
    }
    await linkReviewLogin(tenant.id);
    log.info('demo_tenant.filled', { tenantId: tenant.id, version: SAMPLE_VERSION, anchorDay, ...filled.counts });
    return { action: 'filled', ...describe(await find()), counts: filled.counts };
  }

  /** Makes the demo business when there is none, or when its sample is an older version; otherwise only links the review login. */
  async function ensure({ anchorDay } = {}) {
    const found = await find();
    if (found && found.version === SAMPLE_VERSION) {
      await linkReviewLogin(found.id);
      return { action: 'kept', ...describe(found) };
    }
    return reset({ anchorDay });
  }

  /** The worker's refresh: an out-of-date sample is rebuilt for today, but never while someone is using the business. */
  async function refreshIfIdle() {
    const found = await find();
    if (!found) return { action: 'none' };
    const age = found.anchor_day ? (Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${found.anchor_day}T00:00:00Z`)) / DAY : Infinity;
    if (found.version === SAMPLE_VERSION && age < REFRESH_AFTER_DAYS) return { action: 'kept', ...describe(found) };
    const since = new Date(now() - IDLE_MS);
    const [busy] = await platform.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE tenant_id = $1 AND created_at > $2)
                   OR EXISTS (SELECT 1 FROM review_login_uses WHERE accepted AND created_at > $2)`,
      [found.id, since],
    );
    if (busy) return { action: 'busy', ...describe(found) };
    return reset();
  }

  return { find, status: async () => describe(await find()), ensure, reset, remove, refreshIfIdle };
}
