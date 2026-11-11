import { requirePlatformRole } from '../../auth.js';
import { ApiError } from '../../contracts/api/index.js';
import { platformRoutes as ROUTES } from '../../contracts/api/platform.js';
import { resolveSlots } from '../../contracts/themes.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { FONTS, contrastRatio } from '../brand/theme.js';
import { MIN_CONTRAST } from './accent.js';

/**
 * Bhava's own team, on the platform host (PRD 5.18, 5.19): theme presets as data, and customisation requests triaged to the
 * lowest level of the ladder that meets them. A preset saved here appears in "Pick a look" for every seller at once, with no
 * code change (F-107). A request that is refused with an alternative keeps what was offered (F-100). Nothing here belongs to
 * one business's own code path: it all runs through db.platform.
 */

const COLOR_KEYS = ['ground', 'card', 'ink', 'muted', 'line', 'primary', 'on_primary', 'accent', 'on_accent', 'eyebrow'];
// Text on its background, for every preset: body text on the page and on a card, the button, and text on the accent.
const PAIRS = [['ink', 'ground'], ['ink', 'card'], ['on_primary', 'primary'], ['on_accent', 'accent']];

const invalid = (field, message) => new ApiError('validation_failed', message, { fields: { [field]: message } });

function mount(router, id, handler) {
  const route = ROUTES[id];
  router[route.method.toLowerCase()](route.path, requirePlatformRole(...route.platformRoles), async (req, res, next) => {
    try {
      const parts = {};
      for (const [name, source] of [['params', req.params], ['query', req.query], ['body', req.body ?? {}]]) {
        if (!route[name]) continue;
        const parsed = route[name].safeParse(source);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return res.status(400).json({ error: issue?.message ?? 'Check the details and try again.', fields: { [issue?.path?.join('.') || name]: issue?.message ?? 'Invalid' } });
        }
        parts[name] = parsed.data;
      }
      const result = await handler({ ...parts, user: req.platformUser });
      if (result === null || result === undefined) return res.status(404).json({ error: 'Not found.' });
      return res.status(route.status ?? 200).json(route.response.parse(result));
    } catch (err) {
      if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
      return next(err);
    }
  });
}

const toPreset = (row) => ({
  code: row.code,
  name: row.name,
  madeFor: row.made_for ?? '',
  position: row.position,
  active: row.active,
  colors: row.colors,
  headingFont: row.heading_font,
  bodyFont: row.body_font,
  slots: resolveSlots(row.slots),
});

const toRequest = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  tenantName: row.tenant_name,
  summary: row.summary,
  level: row.level,
  othersWant: row.others_want,
  decision: row.decision,
  alternative: row.alternative,
  feature: row.feature,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
});

const REQUEST_COLS = `r.id, r.tenant_id, t.name AS tenant_name, r.summary, r.level, r.others_want, r.decision, r.alternative, r.feature, r.created_at, r.decided_at`;
const actorOf = (user) => `platform:${user?.id ?? 0}`;

export function registerThemePlatformRoutes(router, ctx) {
  const db = ctx.db.platform;
  const audit = (user, action, target, details = {}) =>
    db.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, $2, $3, $4::jsonb)', [actorOf(user), action, target, JSON.stringify(details)]);

  mount(router, 'platform.themePresets', async () => ({
    items: (await db.query('SELECT code, name, made_for, position, active, colors, heading_font, body_font, slots FROM theme_presets ORDER BY position, code')).map(toPreset),
  }));

  mount(router, 'platform.saveThemePreset', async ({ body, user }) => {
    for (const key of COLOR_KEYS) if (!body.colors[key]) throw invalid(`colors.${key}`, `Set the ${key} colour`);
    for (const [field, font] of [['headingFont', body.headingFont], ['bodyFont', body.bodyFont]]) {
      if (!Object.hasOwn(FONTS, font)) throw invalid(field, `The font “${font.slice(0, 60)}” isn’t available`);
    }
    for (const [text, ground] of PAIRS) {
      const ratio = contrastRatio(body.colors[text], body.colors[ground]);
      if (ratio < MIN_CONTRAST) throw invalid(`colors.${text}`, `${text} on ${ground} needs a contrast of at least ${MIN_CONTRAST}:1, and this pair is ${ratio.toFixed(1)}:1`);
    }
    const colors = Object.fromEntries(COLOR_KEYS.map((key) => [key, body.colors[key].toUpperCase()]));
    const [row] = await db.query(
      `INSERT INTO theme_presets (code, name, made_for, position, active, colors, heading_font, body_font, slots)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, made_for = EXCLUDED.made_for, position = EXCLUDED.position, active = EXCLUDED.active,
         colors = EXCLUDED.colors, heading_font = EXCLUDED.heading_font, body_font = EXCLUDED.body_font, slots = EXCLUDED.slots
       RETURNING code, name, made_for, position, active, colors, heading_font, body_font, slots`,
      [body.code, body.name, body.madeFor, body.position, body.active, JSON.stringify(colors), body.headingFont, body.bodyFont, JSON.stringify(body.slots)],
    );
    await audit(user, 'theme_preset.saved', `preset:${body.code}`, { active: body.active });
    return toPreset(row);
  });

  mount(router, 'platform.customisationRequests', async ({ query }) => {
    const before = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
    const rows = await db.query(
      `SELECT ${REQUEST_COLS} FROM customisation_requests r JOIN tenants t ON t.id = r.tenant_id
       WHERE ($1::integer IS NULL OR r.tenant_id = $1) AND ($2 = 'all' OR r.decision = $2) AND ($3::integer IS NULL OR r.id < $3)
       ORDER BY r.id DESC LIMIT $4`,
      [query.tenantId ?? null, query.decision, before, query.limit + 1],
    );
    const page = pageOfFetched(rows, query.limit, (row) => [row.id]);
    return { items: page.items.map(toRequest), nextCursor: page.nextCursor };
  });

  mount(router, 'platform.createCustomisationRequest', async ({ params, body, user }) => {
    const [tenant] = await db.query('SELECT id, name FROM tenants WHERE id = $1', [params.id]);
    if (!tenant) return null;
    const [row] = await db.query(
      `INSERT INTO customisation_requests (tenant_id, summary, level, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, summary, level, others_want, decision, alternative, feature, created_at, decided_at`,
      [tenant.id, body.summary, body.level, user?.id ?? null],
    );
    await audit(user, 'customisation_request.created', `customisation_request:${row.id}`, { tenantId: tenant.id });
    return toRequest({ ...row, tenant_name: tenant.name });
  });

  // Triage (5.18): which level meets it, and would other businesses want it. A request only one client would ever use is
  // offered as an integration they own (level 4) or declined; custom markup, CSS or script on a buyer page is never accepted.
  mount(router, 'platform.decideCustomisationRequest', async ({ params, body, user }) => {
    if (body.decision === 'accepted' && body.level === 5 && !body.othersWant) {
      throw invalid('decision', 'A new core feature is built only when other businesses would use it. Offer an integration instead, or decline.');
    }
    if (body.decision === 'accepted' && body.level === 5 && !body.feature) throw invalid('feature', 'Name the flag this feature is built behind');
    const [row] = await db.query(
      `UPDATE customisation_requests r SET decision = $2, level = $3, others_want = $4, alternative = $5, feature = $6, decided_by = $7, decided_at = now()
       FROM tenants t WHERE r.id = $1 AND t.id = r.tenant_id AND r.decision = 'open'
       RETURNING ${REQUEST_COLS}`,
      [params.id, body.decision, body.level, body.othersWant, body.alternative, body.feature, user?.id ?? null],
    );
    if (!row) {
      const [existing] = await db.query('SELECT id FROM customisation_requests WHERE id = $1', [params.id]);
      if (!existing) return null;
      throw new ApiError('conflict', 'This request has already been decided.');
    }
    await audit(user, 'customisation_request.decided', `customisation_request:${row.id}`, { decision: body.decision, level: body.level, tenantId: row.tenant_id });
    return toRequest(row);
  });
}
