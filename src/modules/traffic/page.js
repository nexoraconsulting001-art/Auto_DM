import crypto from 'node:crypto';
import { ANALYTICS_LIMITS as L, TRAFFIC_PATHS, VISITOR_COOKIE } from '../../contracts/analytics.js';
import { TrafficBeacon } from '../../contracts/api/index.js';
import { reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { isBuyerPage, pageOf } from './page-kinds.js';
import { TRAFFIC_SCRIPT } from './script.js';
import { contentSecurityPolicy, tagSnippet } from './tags.js';
import { automatedKind } from './ua.js';

const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE_MAX_AGE_MS = L.visitorCookieDays * 86_400_000;
const TEAM_ROLES = new Set(['owner', 'manager', 'staff']);
const OUTBOUND_HOST = /^[a-z0-9.-]{1,253}$/i;

// A page load sends a handful of hits, and many shoppers can share one carrier address. This only stops one source flooding the table.
const HITS_PER_MINUTE = 1200;
const MAX_TRACKED_ADDRESSES = 50_000;

const escapeAttr = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

const visitorFrom = (req) => {
  const value = readCookie(req, VISITOR_COOKIE);
  return IS_UUID.test(value) ? value.toLowerCase() : null;
};

function setVisitorCookie(req, res, id) {
  res.cookie(VISITOR_COOKIE, id, { path: '/', maxAge: COOKIE_MAX_AGE_MS, httpOnly: true, sameSite: 'lax', secure: req.secure });
}

function floodGuard() {
  let minute = 0;
  let hits = new Map();
  return (key) => {
    const current = Math.floor(Date.now() / 60_000);
    if (current !== minute || hits.size > MAX_TRACKED_ADDRESSES) {
      minute = current;
      hits = new Map();
    }
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    return n > HITS_PER_MINUTE;
  };
}

/** A page of the seller's own site calling its own beacon. Non-browser callers send neither header and are handled as hits. */
function sameSite(req) {
  if (req.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

const previewFromPage = (req) => /[?&]preview=/.test(req.get('referer') ?? '');

/** The signed-in person behind a hit, if any: the beacon runs before the app's sign-in step. */
function whoIsSignedIn(req, res, ctx) {
  if (!readCookie(req, 'sid')) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    ctx.auth.load(req, res, (err) => (err ? reject(err) : resolve(req.user ?? null)));
  });
}

/**
 * The beacon and the script, on the seller's own domain. Registered before the business is worked out, because a buyer's POST has no CSRF token: the business is
 * found from the host, never from the body. A failure here is never the buyer's problem, so it answers 204 whenever the hit was well formed.
 */
export function registerBeacon(app, ctx, { ingest, destinations }) {
  const flooded = floodGuard();

  // The tag a seller pastes on their own site reports here, from another origin, with no body and no credentials: one visit to one reel, and nothing about who.
  app.post('/_t/d', async (req, res) => {
    const mediaId = typeof req.query.m === 'string' && /^[\w-]{1,80}$/.test(req.query.m) ? req.query.m : null;
    const tenant = mediaId ? await ctx.tenantResolver.resolve(req.hostname) : null;
    if (tenant && !flooded(`${tenant.id}:${req.ip}`)) await withTenant(tenant, () => destinations.recordSiteVisit(mediaId)).catch((err) => reportError(err, { msg: 'traffic.site_visit_failed' }));
    res.sendStatus(204);
  });

  app.get(TRAFFIC_PATHS.script, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('application/javascript').send(TRAFFIC_SCRIPT);
  });

  app.post(TRAFFIC_PATHS.event, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!sameSite(req)) return res.sendStatus(403);
    const parsed = TrafficBeacon.safeParse(req.body);
    if (!parsed.success) return res.sendStatus(400);
    const tenant = await ctx.tenantResolver.resolve(req.hostname);
    if (!tenant) return res.sendStatus(404);
    if (flooded(`${tenant.id}:${req.ip}`)) return res.sendStatus(429);

    const beacon = { ...parsed.data, outboundHost: OUTBOUND_HOST.test(parsed.data.outboundHost) ? parsed.data.outboundHost.toLowerCase() : '' };
    let visitorId = visitorFrom(req);
    let mintedVisitorId = null;
    if (!visitorId) {
      mintedVisitorId = crypto.randomUUID();
      setVisitorCookie(req, res, mintedVisitorId);
    }
    const anonToken = typeof req.query.v === 'string' && /^[\w-]{1,64}$/.test(req.query.v) ? req.query.v : '';
    try {
      await withTenant(tenant, async () => {
        const automated = automatedKind(req.get('user-agent'));
        if (automated) return ingest.preview(automated, beacon.pageKind);
        if (previewFromPage(req)) return ingest.preview('owner_preview', beacon.pageKind);
        const user = await whoIsSignedIn(req, res, ctx);
        if (TEAM_ROLES.has(user?.role)) return ingest.preview('team', beacon.pageKind);
        return ingest.hit(beacon, { visitorId, anonToken, mintedVisitorId, ua: req.get('user-agent') ?? '', ip: String(req.ip ?? '').replace(/^::ffff:/, ''), host: req.hostname, user });
      });
    } catch (err) {
      reportError(err, { msg: 'traffic.hit_failed', event: beacon.name });
    }
    res.sendStatus(204);
  });
}

/** Everything a buyer page gets: the script, the seller's tags when allowed, and the policy that allows them. No view has to change. */
export function pageMiddleware(ctx, ingest, tags) {
  return async (req, res, next) => {
    if (req.method !== 'GET' || !isBuyerPage(req.path)) return next();
    const page = pageOf(req.path);
    let state;
    let allowTags = false;
    const automated = automatedKind(req.get('user-agent'));
    const excluded = automated ?? (req.query?.preview ? 'owner_preview' : TEAM_ROLES.has(req.user?.role) ? 'team' : null);
    let visitorId = visitorFrom(req);
    try {
      state = await tags.pageState();
      if (!excluded && !visitorId) {
        visitorId = crypto.randomUUID();
        setVisitorCookie(req, res, visitorId);
      }
      if (state.any && !excluded && !page.noTags) allowTags = await tags.granted(visitorId, req.user?.role === 'customer' ? req.user.id : undefined);
    } catch (err) {
      // Analytics must never take a page down. With no answer about tags, none load and the policy names none.
      reportError(err, { msg: 'traffic.page_state_failed' });
      state = undefined;
    }

    const send = res.send.bind(res);
    res.send = (body) => {
      res.send = send;
      if (typeof body !== 'string' || !/text\/html/i.test(res.get('content-type') ?? '')) return send(body);
      res.set('Content-Security-Policy', contentSecurityPolicy(state));
      if (res.statusCode !== 200) return send(body);
      // A page that knows better than its address says what it is (Phase 3: the creator page at /<slug>; sendBuyerPage in src/views/buyer).
      if (res.locals.page?.kind) Object.assign(page, { kind: res.locals.page.kind, ref: String(res.locals.page.ref ?? '') });
      if (excluded) {
        ingest.preview(excluded, page.kind).catch((err) => reportError(err, { msg: 'traffic.preview_failed' }));
        return send(body);
      }
      const eventId = crypto.randomBytes(12).toString('base64url');
      const script = `<script src="${TRAFFIC_PATHS.script}" defer data-k="${page.kind}" data-r="${escapeAttr(page.ref)}" data-e="${eventId}"${allowTags && state.commerce ? ' data-c="1"' : ''}></script>`;
      return send(injected(body, allowTags ? tagSnippet(state) : '', script));
    };
    next();
  };
}

function injected(html, head, script) {
  const withHead = head ? insertBefore(html, '</head>', head) : html;
  return insertBefore(withHead, '</body>', script);
}

function insertBefore(html, closing, addition) {
  const at = html.toLowerCase().lastIndexOf(closing);
  return at === -1 ? html + addition : html.slice(0, at) + addition + html.slice(at);
}
