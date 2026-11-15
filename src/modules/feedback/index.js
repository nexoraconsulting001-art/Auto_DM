import { requirePlatformRole } from '../../auth.js';
import { FEEDBACK_PLATFORM_OWNERS, platformRoutes } from '../../contracts/api/platform.js';
import { log } from '../../platform/log.js';
import { Refusal, idCursor, mountRoute, platformAudit } from '../platform-console/mount.js';

const PLATFORM = FEEDBACK_PLATFORM_OWNERS.feedback;
const ID = /^[1-9]\d{0,9}$/;

const COLUMNS = `f.id, f.tenant_id, t.name AS tenant_name, f.said_by, f.area, f.body, f.severity, f.state, f.fixed_in,
  COALESCE(u.email, '') AS created_by, f.created_at, f.updated_at`;
const FROM = `feedback_items f JOIN tenants t ON t.id = f.tenant_id LEFT JOIN platform_users u ON u.id = f.created_by`;

/** One row as the contract's FeedbackItem. The words are returned exactly as written: the screen escapes them. */
const toItem = (r) => ({
  id: Number(r.id), tenantId: r.tenant_id, tenantName: r.tenant_name ?? '', saidBy: r.said_by, area: r.area, text: r.body,
  severity: r.severity, state: r.state, fixedIn: r.fixed_in, createdBy: r.created_by ?? '', createdAt: r.created_at, updatedAt: r.updated_at,
});

/**
 * Feedback from showcase sessions (Phase 8, Q-13): logged against the business that gave it, tracked from `new` to
 * `planned` and then `fixed` (with what fixed it) or `declined`, and listed in the Platform Console. The table is
 * feedback_items (migration 810): the platform's, out of reach of business code, so every query here is on db.platform.
 *
 *   platform.feedback         GET   /feedback                 every item, newest first; filter by business and state
 *   platform.createFeedback   POST  /tenants/:id/feedback     who said it, where in the product, the words, a severity
 *   platform.updateFeedback   PATCH /feedback/:id             state, severity, fixedIn; `fixed` needs fixedIn, and only `fixed` has it
 *
 * Only the platform's support and super admin roles reach any of it (the route table's platformRoles); a business's own
 * session never does. Creating and updating are audited with the operator and ids only: the words are never copied to the
 * audit log or a log line. The screen is console/src/platform/features/feedback.
 */
export function registerFeedbackRoutes(router, ctx) {
  const { db } = ctx;
  const pdb = db.platform ?? db;
  const byId = async (id) => (await pdb.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE f.id = $1`, [id]))[0] ?? null;

  // A path id that is not a number is a mistake to correct (400), not a missing page: said before the shared mount's 404.
  const update = platformRoutes['platform.updateFeedback'];
  router.patch(update.path, requirePlatformRole(...update.platformRoles), (req, res, next) => {
    if (ID.test(String(req.params.id))) return next();
    return res.status(400).set('Cache-Control', 'no-store').json({ error: 'That is not a feedback item.' });
  });

  mountRoute(router, 'platform.feedback', async ({ query }) => {
    const rows = await pdb.query(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE ($1::integer IS NULL OR f.tenant_id = $1)
          AND ($2::text IS NULL OR f.state = $2)
          AND ($3::bigint IS NULL OR f.id < $3)
        ORDER BY f.id DESC LIMIT $4`,
      [query.tenantId ? Number(query.tenantId) : null, query.state === 'all' ? null : query.state, idCursor(query.cursor), query.limit + 1],
    );
    const items = rows.slice(0, query.limit).map(toItem);
    return { items, nextCursor: rows.length > query.limit ? String(items.at(-1).id) : null };
  });

  mountRoute(router, 'platform.createFeedback', async ({ params, body, user, actor }) => {
    const [tenant] = await pdb.query('SELECT id FROM tenants WHERE id = $1', [params.id]);
    if (!tenant) throw new Refusal(404, 'Not found.');
    const [row] = await pdb.query(
      `INSERT INTO feedback_items (tenant_id, said_by, area, body, severity, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, body.saidBy, body.area, body.text, body.severity, user?.id ?? null],
    );
    await platformAudit(db, { tenantId: tenant.id, actor, action: 'feedback.create', target: String(row.id), details: { severity: body.severity } });
    log.info('feedback.created', { tenant: tenant.id, feedbackId: Number(row.id) });
    return toItem(await byId(row.id));
  });

  mountRoute(router, 'platform.updateFeedback', async ({ params, body, actor }) => {
    const found = await byId(params.id);
    if (!found) throw new Refusal(404, 'Not found.');
    const state = body.state ?? found.state;
    const fixedIn = body.state !== undefined ? (state === 'fixed' ? body.fixedIn.trim() : '') : (body.fixedIn?.trim() ?? found.fixed_in);
    if (body.state === undefined && body.fixedIn !== undefined && (found.state !== 'fixed' || !fixedIn)) {
      throw new Refusal(400, 'Only a fixed item says what fixed it.', 'validation');
    }
    const severity = body.severity ?? found.severity;
    await pdb.query(
      `UPDATE feedback_items SET state = $2, severity = $3, fixed_in = $4, updated_at = now() WHERE id = $1`,
      [found.id, state, severity, fixedIn],
    );
    await platformAudit(db, { tenantId: found.tenant_id, actor, action: 'feedback.update', target: String(found.id), details: { from: found.state, state, severity } });
    log.info('feedback.updated', { tenant: found.tenant_id, feedbackId: Number(found.id), state });
    return toItem(await byId(found.id));
  });
}

export const feedback = {
  name: 'feedback',
  owns: { migrations: ['810_feedback.sql'], tables: ['feedback_items'], api: [], store: [], platform: PLATFORM, jobs: [] },
  platformRoutes: (router, ctx) => registerFeedbackRoutes(router, ctx),
};
