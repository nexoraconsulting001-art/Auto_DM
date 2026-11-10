import crypto from 'node:crypto';
import { ANALYTICS_LIMITS as L } from '../../contracts/analytics.js';
import { tenantId } from '../../tenancy.js';
import { pageOf, storablePath } from './page-kinds.js';
import { countSession, encodeDims, loadDims, writeSession } from './sessions.js';
import { referrerDomainOf, sessionSource } from './source.js';
import { clockOf, localParts, sameSession, timeZoneOf } from './time.js';
import { describeAgent } from './ua.js';

/** Only the server can say these happened: a browser can't claim an order or a two-tap tap. */
const SERVER_ONLY_EVENTS = new Set(['order', 'link_tap']);
const META_MEDIA_ID = /^\d{6,}$/;
const ANON_TTL_S = Math.ceil(L.sessionIdleMs / 1000) + 60;
const MAX_ENGAGED_MS = 86_400_000;

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const anonKey = (token) => `traffic:anon:${tenantId()}:${sha(token).slice(0, 32)}`;
const mintKey = (visitorId) => `traffic:mint:${tenantId()}:${visitorId}`;

/**
 * Takes one hit and turns it into an event and a session. The IP and user agent are read here and go no further: only what is derived from them is kept,
 * and traffic_events has no column for either. Everything runs as the business the host belongs to, never one named in the body.
 */
export function createIngest(ctx, tags) {
  const { db, platform, config } = ctx;
  const rollups = platform.analytics.rollups;
  const now = clockOf(config);

  async function triggerFor(runner, utm) {
    if (String(utm.medium).toLowerCase() !== 'dm' || !utm.campaign) return '';
    const [row] = await runner.query('SELECT trigger_type FROM automations WHERE tenant_id = $1 AND slug = $2', [tenantId(), utm.campaign]);
    return row?.trigger_type ?? '';
  }

  async function mediaFor(runner, beacon, page) {
    if (beacon.mediaId) return beacon.mediaId;
    if (META_MEDIA_ID.test(beacon.utm.content)) return beacon.utm.content;
    if (page.kind !== 'landing' || !page.ref) return '';
    const [reel] = await runner.query('SELECT ig_media_id FROM reels WHERE tenant_id = $1 AND slug = $2', [tenantId(), page.ref]);
    return reel?.ig_media_id ?? '';
  }

  /** Only a product or category of this business is linked: the id in the body is just a claim. The event then describes that item. */
  async function resolveItem(runner, beacon, page) {
    const tid = tenantId();
    const item = { kind: page.kind, ref: page.ref, productId: null, categoryId: null };
    const product = beacon.productId
      ? (await runner.query('SELECT id, slug FROM products WHERE tenant_id = $1 AND id = $2', [tid, beacon.productId]))[0]
      : page.kind === 'product' && page.ref ? (await runner.query('SELECT id, slug FROM products WHERE tenant_id = $1 AND slug = $2', [tid, page.ref]))[0] : null;
    if (product) Object.assign(item, { kind: 'product', ref: product.slug, productId: product.id });
    const category = beacon.categoryId
      ? (await runner.query('SELECT id, slug FROM categories WHERE tenant_id = $1 AND id = $2', [tid, beacon.categoryId]))[0]
      : page.kind === 'category' && page.ref ? (await runner.query('SELECT id, slug FROM categories WHERE tenant_id = $1 AND slug = $2', [tid, page.ref]))[0] : null;
    if (category) {
      item.categoryId = category.id;
      if (!product) Object.assign(item, { kind: 'category', ref: category.slug });
    }
    return item;
  }

  function newDims(beacon, request, { at, local, source, referrerDomain, mediaId, visitorId, visitorType, path }) {
    const geo = platform.geo.lookup(request.ip) ?? {};
    return {
      visitor_id: visitorId,
      day: local.day,
      hour: local.hour,
      weekday: local.weekday,
      source,
      referrer_domain: referrerDomain,
      utm_source: beacon.utm.source,
      utm_medium: beacon.utm.medium,
      utm_campaign: beacon.utm.campaign,
      utm_content: beacon.utm.content,
      media_id: mediaId,
      landing_page: path,
      ...describeAgent(request.ua),
      city: String(geo.city ?? ''),
      state: String(geo.state ?? ''),
      visitor_type: visitorType,
      started_at: at.toISOString(),
      last_hit_at: at.toISOString(),
      engaged_ms: 0,
    };
  }

  /** Locks the visitor, so two hits at once can't each start a session. A brand-new one has no row until now. */
  const upsertVisitor = async (t, visitorId, source, at) => (await t.query(
    `INSERT INTO traffic_visitors (tenant_id, visitor_id, first_seen_at, first_source, last_seen_at) VALUES ($1, $2, $3::timestamptz, $4, $3::timestamptz)
     ON CONFLICT (tenant_id, visitor_id) DO UPDATE SET last_seen_at = traffic_visitors.last_seen_at
     RETURNING last_session_id, (xmax = 0) AS created`,
    [tenantId(), visitorId, at, source],
  ))[0];

  const insertEvent = async (t, fields) => (await t.query(
    `INSERT INTO traffic_events (tenant_id, session_id, visitor_id, at, surface, name, page_kind, page_ref, path, media_id, product_id, category_id, order_id, outbound_host, value_paise, event_key)
     VALUES ($1, $2, $3, $4::timestamptz, 'buyer_page', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (tenant_id, event_key) WHERE event_key <> '' DO NOTHING RETURNING id`,
    [tenantId(), fields.sessionId, fields.visitorId, fields.at, fields.name, fields.pageKind, fields.pageRef, fields.path, fields.mediaId, fields.productId, fields.categoryId, fields.orderId ?? null, fields.host, fields.valuePaise, fields.eventKey],
  )).length > 0;

  /** The session to continue, or null. A cookie first handed out on an earlier hit claims the session that hit started. */
  async function continuing(t, { visitorId, visitor, anon, minted, at, local }) {
    const id = visitor?.created ? minted?.sessionId : visitorId ? visitor?.last_session_id : anon?.sessionId;
    if (!id) return null;
    const found = await loadDims(t, id, { lock: true });
    if (!found || !sameSession(new Date(found.dims.last_hit_at), at, found.dims.day, local.day)) return null;
    return { sessionId: id, ...found };
  }

  async function claimMinted(t, visitorId, session) {
    Object.assign(session.dims, { visitor_id: visitorId, visitor_type: 'new' });
    await t.query('UPDATE traffic_events SET visitor_id = $3 WHERE tenant_id = $1 AND session_id = $2 AND visitor_id IS NULL', [tenantId(), session.sessionId, visitorId]);
  }

  /** One browser hit. `request` is { visitorId, anonToken, mintedVisitorId, ua, ip, host, user }. */
  async function hit(beacon, request) {
    if (SERVER_ONLY_EVENTS.has(beacon.name)) return { ignored: true };
    const at = new Date(now());
    const timeZone = await timeZoneOf(db);
    const local = localParts(at, timeZone);
    const path = storablePath(beacon.path);
    const page = beacon.pageKind === 'other' && !beacon.pageRef ? pageOf(path) : { kind: beacon.pageKind, ref: beacon.pageRef };
    const anon = request.visitorId || !request.anonToken ? null : await platform.cache.get(anonKey(request.anonToken));
    const minted = request.visitorId ? await platform.cache.get(mintKey(request.visitorId)) : null;
    const referrerDomain = referrerDomainOf(beacon.referrer, request.host);

    const result = await db.tx(async (t) => {
      const trigger = await triggerFor(t, beacon.utm);
      const source = sessionSource({ utm: beacon.utm, src: beacon.src, referrerDomain, trigger });
      const visitor = request.visitorId ? await upsertVisitor(t, request.visitorId, source, at) : null;
      let session = await continuing(t, { visitorId: request.visitorId, visitor, anon, minted, at, local });
      if (session && visitor?.created) await claimMinted(t, request.visitorId, session);

      const isNew = !session;
      const item = await resolveItem(t, beacon, page);
      const mediaId = session?.dims.media_id || await mediaFor(t, beacon, page);
      const sessionId = session?.sessionId ?? crypto.randomUUID();
      const dims = session?.dims ?? newDims(beacon, request, { at, local, source, referrerDomain, mediaId, path, visitorId: request.visitorId, visitorType: request.visitorId ? (visitor.created ? 'new' : 'returning') : 'unknown' });
      if (beacon.engagedMs) dims.engaged_ms = Math.min(MAX_ENGAGED_MS, (dims.engaged_ms ?? 0) + beacon.engagedMs);
      dims.last_hit_at = at.toISOString();

      // A real payment is recorded by the server from the order. A beacon's value must never reach revenue.
      const valuePaise = beacon.name === 'payment_success' ? 0 : beacon.valuePaise;
      const inserted = await insertEvent(t, {
        sessionId, visitorId: request.visitorId, at, name: beacon.name, pageKind: item.kind, pageRef: item.ref.slice(0, 200), path, mediaId: beacon.mediaId || mediaId,
        productId: item.productId, categoryId: item.categoryId, host: isNew ? encodeDims(dims) : beacon.outboundHost, valuePaise, eventKey: beacon.eventId ? `${beacon.name}:${beacon.eventId}` : '',
      });
      if (!inserted && isNew) return { duplicate: true };
      if (!isNew) await t.query('UPDATE traffic_events SET outbound_host = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), session.rowId, encodeDims(dims)]);
      if (request.visitorId) await t.query('UPDATE traffic_visitors SET last_seen_at = $3::timestamptz, last_session_id = $4 WHERE tenant_id = $1 AND visitor_id = $2', [tenantId(), request.visitorId, at, sessionId]);
      return { sessionId, dims, isNew, inserted, counters: await countSession(t, sessionId), mediaId: beacon.mediaId || mediaId };
    });
    if (result.duplicate) return result;

    await writeSession(rollups, result.sessionId, result.dims, result.counters);
    if (!request.visitorId) await rememberAnon(request, result);
    if (result.isNew && result.dims.media_id) await recordVisit(result, at);
    if (result.inserted) await tags.onBrowserEvent(beacon, { at, visitorId: request.visitorId, sessionId: result.sessionId, user: request.user, host: request.host, path });
    return result;
  }

  async function rememberAnon(request, result) {
    if (request.anonToken) await platform.cache.set(anonKey(request.anonToken), { sessionId: result.sessionId }, ANON_TTL_S);
    if (request.mintedVisitorId) await platform.cache.set(mintKey(request.mintedVisitorId), { sessionId: result.sessionId }, ANON_TTL_S);
  }

  /** A session that came from a piece of content is a visit to it (7.4). No person is named here: it is one per session. */
  async function recordVisit({ sessionId, dims }, at) {
    await db.query(
      `INSERT INTO funnel_events (tenant_id, channel, media_id, content_kind, stage, origin, source_label, dedupe_key, occurred_at)
       VALUES ($1, $2, $3, '', 'taps_or_visits', 'bhava_page', 'bhava', $4, $5::timestamptz) ON CONFLICT (tenant_id, stage, dedupe_key) DO NOTHING`,
      [tenantId(), dims.source.startsWith('facebook') ? 'facebook' : 'instagram', dims.media_id, `visit:${sessionId}`, at],
    );
  }

  /** Excluded from every count and counted here instead (7.10). */
  async function preview(kind, pageKind) {
    const timeZone = await timeZoneOf(db);
    await db.query(
      `INSERT INTO traffic_previews (tenant_id, day, kind, page_kind, n) VALUES ($1, $2::date, $3, $4, 1)
       ON CONFLICT (tenant_id, day, kind, page_kind) DO UPDATE SET n = traffic_previews.n + 1`,
      [tenantId(), localParts(new Date(now()), timeZone).day, kind, pageKind],
    );
  }

  /** Ties a new order to the visit that placed it. Its money is read from the order whenever it is counted, never from here. */
  async function linkOrder(order, visitorId) {
    if (!visitorId) return null;
    const at = new Date(now());
    const local = localParts(at, await timeZoneOf(db));
    const result = await db.tx(async (t) => {
      const [visitor] = await t.query('SELECT last_session_id FROM traffic_visitors WHERE tenant_id = $1 AND visitor_id = $2 FOR UPDATE', [tenantId(), visitorId]);
      if (!visitor) return null;
      const found = visitor.last_session_id ? await loadDims(t, visitor.last_session_id, { lock: true }) : null;
      // Only a session still going is the visit that placed the order. The order still knows its visitor, for the 7-day rule (7.4).
      const session = found && sameSession(new Date(found.dims.last_hit_at), at, found.dims.day, local.day) ? found : null;
      const sessionId = session ? visitor.last_session_id : null;
      const inserted = await insertEvent(t, { sessionId, visitorId, at, name: 'order', pageKind: 'checkout', pageRef: '', path: '/checkout', mediaId: '', productId: null, categoryId: null, orderId: order.id, host: '', valuePaise: 0, eventKey: `order:${order.id}` });
      return inserted && session ? { sessionId, dims: session.dims, counters: await countSession(t, sessionId) } : null;
    });
    if (result) await writeSession(rollups, result.sessionId, result.dims, result.counters);
    return result;
  }

  return { hit, preview, linkOrder };
}
