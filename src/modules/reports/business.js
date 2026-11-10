import { isAllowed, staffWith } from '../../contracts/api/index.js';
import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { tenantBaseUrl } from '../admin-api/urls.js';
import { safeZone } from './clock.js';
import { logoSource } from './render.js';

const READER = staffWith('analytics');

/** Who on the team may read analytics: the owner, managers, and staff holding the analytics permission. Shoppers never. */
export const readsAnalytics = (user) => Boolean(user) && isAllowed(user, READER);

/** Business statuses in which reports go out. A paused, suspended, closed or killed business gets none (7.13). */
export const REPORTING_STATUSES = Object.freeze(['onboarding', 'active']);

/** The current business as a report shows it: its name, its own address for links, its logo as the workspace identity, its clock. */
export async function currentBusiness({ db, repos, config }) {
  const [row] = await db.query('SELECT id, slug, name, status, timezone FROM tenants WHERE id = $1', [tenantId()]);
  if (!row) return null;
  const base = tenantBaseUrl(row, config ?? {}) || '';
  let logo = '';
  try {
    logo = (await repos.brandKit.get())?.logoUrl ?? '';
  } catch (err) {
    reportError(err, { msg: 'reports.brand_failed' });
  }
  return { id: row.id, slug: row.slug, name: row.name, status: row.status, timeZone: safeZone(row.timezone), base, logoUrl: logoSource(logo, base), reporting: REPORTING_STATUSES.includes(row.status) };
}

/** The team members who can get a report, oldest first. */
export async function teamReaders(db) {
  const rows = await db.query(`SELECT id, name, role, email, permissions FROM users WHERE tenant_id = $1 AND role IN ('owner', 'manager', 'staff') ORDER BY id`, [tenantId()]);
  return rows.filter(readsAnalytics);
}
