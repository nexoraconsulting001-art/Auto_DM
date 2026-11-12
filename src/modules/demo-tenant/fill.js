import { changeOrder } from '../orders/state.js';
import { tenantId } from '../../tenancy.js';

/**
 * Writes a sample (sample.js) into the demo business, inside the caller's transaction `t`, inside withTenant() of that
 * business. Every row names tenantId() and every link between rows carries it, so the composite keys refuse anything
 * that would point into another business. Orders are placed pending and unpaid and moved through the order state
 * machine (src/modules/orders/state.js) like a checkout's, so the database writes their timeline and events itself.
 *
 * Bulk rows go in as one jsonb array per table (jsonb_to_recordset), so a fill is a few dozen statements.
 */
const ACTOR = 'job:demo-tenant';

const json = (value) => JSON.stringify(value);

async function bulk(t, sql, rows) {
  if (!rows.length) return [];
  return t.query(sql, [tenantId(), json(rows)]);
}

async function writeProducts(t, sample) {
  const rows = await bulk(t,
    `INSERT INTO products (tenant_id, name, slug, description, price_paise, mrp_paise, stock, active, featured, tags, source, price_manual, in_stock, hsn_code, gst_rate_bp, weight_grams, created_at, updated_at)
     SELECT $1, x.name, x.slug, x.description, x.price_paise, x.mrp_paise, x.stock, true, x.featured, x.tags, 'manual', true, true, x.hsn_code, x.gst_rate_bp, 400, x.created_at, x.created_at
     FROM jsonb_to_recordset($2::jsonb) AS x(name text, slug text, description text, price_paise bigint, mrp_paise bigint, stock integer, featured boolean, tags text[], hsn_code text, gst_rate_bp integer, created_at timestamptz)
     RETURNING id, slug`,
    sample.products.map((p) => ({ name: p.name, slug: p.slug, description: p.description, price_paise: p.pricePaise, mrp_paise: p.mrpPaise, stock: p.stock, featured: p.featured, tags: p.tags, hsn_code: p.hsnCode, gst_rate_bp: p.gstRateBp, created_at: p.createdAt })),
  );
  const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
  return new Map(sample.products.map((p) => [p.key, idBySlug.get(p.slug)]));
}

async function writePages(t, sample, productIds) {
  const rows = await bulk(t,
    `INSERT INTO reels (ig_media_id, tenant_id, slug, headline, keywords, caption, kind, channel, media_type, posted_at, active, media_checked_at, created_at, updated_at)
     SELECT x.media_id, $1, x.slug, x.headline, x.keywords, x.caption, x.kind, 'instagram', x.media_type, x.posted_at, true, x.created_at, x.created_at, x.created_at
     FROM jsonb_to_recordset($2::jsonb) AS x(media_id text, slug text, headline text, keywords text[], caption text, kind text, media_type text, posted_at timestamptz, created_at timestamptz)
     RETURNING id, slug, ig_media_id`,
    sample.pages.map((p) => ({ media_id: p.mediaId, slug: p.slug, headline: p.headline, keywords: p.keywords, caption: p.caption, kind: p.kind, media_type: p.mediaType, posted_at: p.postedAt, created_at: p.createdAt })),
  );
  await bulk(t,
    `INSERT INTO reel_products (tenant_id, reel_id, product_id, position)
     SELECT $1, x.reel_id, x.product_id, x.position FROM jsonb_to_recordset($2::jsonb) AS x(reel_id text, product_id integer, position integer)`,
    sample.pages.flatMap((p) => p.productKeys.map((key, position) => ({ reel_id: p.mediaId, product_id: productIds.get(key), position }))),
  );
  return new Map(rows.map((r) => [r.slug, { id: r.id, mediaId: r.ig_media_id }]));
}

async function writeAccount(t, sample) {
  const { account, insights } = sample;
  // Migration 540 keeps this account without a token and never "active", whatever is written here.
  await t.query(
    `INSERT INTO ig_accounts (ig_user_id, tenant_id, username, status, status_reason, status_changed_at, connected_at, created_at)
     VALUES ($2, $1, $3, 'reconnect_needed', 'token.rejected', $4::timestamptz, $5::timestamptz, $5::timestamptz)`,
    [tenantId(), account.igUserId, account.username, account.lostAt, account.connectedAt],
  );
  const [{ id: ref }] = await t.query(
    `INSERT INTO analytics_accounts (tenant_id, channel, ig_user_id, collecting_since, permission, stories_edge, online_followers, followers_count, followers_at, media_listed_at, last_refresh_at, created_at)
     VALUES ($1, 'instagram', $2, $3::date, 'ok', 'available', 'available', $4, $5::timestamptz, $5::timestamptz, $5::timestamptz, $6::timestamptz) RETURNING id`,
    [tenantId(), account.igUserId, insights.collectingSince, insights.followers, insights.lastRefreshAt, account.connectedAt],
  );
  await t.query('INSERT INTO insight_settings (tenant_id, poll_offset_sec) VALUES ($1, 0)', [tenantId()]);
  return ref;
}

async function writeInsights(t, sample, ref) {
  const { insights } = sample;
  await t.query(
    `INSERT INTO insight_daily (tenant_id, account_ref, day, metric, breakdown, breakdown_value, value, estimated, fetched_at)
     SELECT $1, $2, x.day, x.metric, x.breakdown, x.breakdown_value, x.value, x.estimated, $3::timestamptz
     FROM jsonb_to_recordset($4::jsonb) AS x(day date, metric text, breakdown text, breakdown_value text, value bigint, estimated boolean)`,
    [tenantId(), ref, insights.fetchedAt, json(insights.daily.map((r) => ({ day: r.day, metric: r.metric, breakdown: r.breakdown, breakdown_value: r.breakdownValue, value: r.value, estimated: ['views', 'reach'].includes(r.metric) })))],
  );
  await t.query(
    `INSERT INTO insight_demographics (tenant_id, account_ref, metric, timeframe, breakdown, breakdown_value, value, fetched_at)
     SELECT $1, $2, x.metric, x.timeframe, x.breakdown, x.breakdown_value, x.value, $3::timestamptz
     FROM jsonb_to_recordset($4::jsonb) AS x(metric text, timeframe text, breakdown text, breakdown_value text, value bigint)`,
    [tenantId(), ref, insights.fetchedAt, json(insights.demographics.map((r) => ({ metric: r.metric, timeframe: r.timeframe, breakdown: r.breakdown, breakdown_value: r.breakdownValue, value: r.value })))],
  );
  await t.query(
    `INSERT INTO insight_online_followers (tenant_id, account_ref, weekday, hour, value, fetched_at)
     SELECT $1, $2, x.weekday, x.hour, x.value, $3::timestamptz FROM jsonb_to_recordset($4::jsonb) AS x(weekday smallint, hour smallint, value bigint)`,
    [tenantId(), ref, insights.fetchedAt, json(insights.online)],
  );
  await t.query(
    `INSERT INTO insight_media (tenant_id, account_ref, media_id, kind, caption, permalink, thumbnail_url, posted_at, latest, latest_at, created_at)
     SELECT $1, $2, x.media_id, x.kind, x.caption, x.permalink, x.thumbnail_url, x.posted_at, x.latest, x.latest_at, x.posted_at
     FROM jsonb_to_recordset($3::jsonb) AS x(media_id text, kind text, caption text, permalink text, thumbnail_url text, posted_at timestamptz, latest jsonb, latest_at timestamptz)`,
    [tenantId(), ref, json(insights.media.map((m) => ({ media_id: m.mediaId, kind: m.kind, caption: m.caption, permalink: m.permalink, thumbnail_url: m.thumbnailUrl, posted_at: m.postedAt, latest: m.metrics, latest_at: m.latestAt })))],
  );
}

async function writeAutomations(t, sample) {
  for (const a of sample.automations) {
    const [row] = await t.query(
      `INSERT INTO automations (tenant_id, name, slug, state, paused_reason, trigger_type, match_mode, any_mode_acknowledged, keywords, link_mode, link_type, link_url,
         public_reply_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, 'two_tap', 'bhava_page', '', $10, $11::timestamptz, $12::timestamptz) RETURNING id`,
      [tenantId(), a.name, a.slug, a.state, a.state === 'paused' ? 'paused.automation' : '', a.triggerType, a.matchMode, a.matchMode === 'any' ? a.createdAt : null,
        a.keywords, a.publicReply, a.createdAt, a.updatedAt],
    );
    for (const trigger of a.triggers) {
      await t.query(
        `INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id, caption, active, created_at)
         VALUES ($1, $2, 'instagram', $3, $4, '', true, $5::timestamptz)`,
        [tenantId(), row.id, trigger.targetType, trigger.mediaId, a.createdAt],
      );
    }
    const [first] = await t.query(
      `INSERT INTO message_templates (tenant_id, automation_id, role, created_at, updated_at) VALUES ($1, $2, 'first_dm', $3::timestamptz, $3::timestamptz) RETURNING id`,
      [tenantId(), row.id, a.createdAt],
    );
    for (const v of a.variants) {
      await t.query(
        `INSERT INTO template_variants (tenant_id, template_id, label, body, button_title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)`,
        [tenantId(), first.id, v.label, v.body, v.button, a.createdAt],
      );
    }
    if (a.linkMessage) {
      const [link] = await t.query(
        `INSERT INTO message_templates (tenant_id, automation_id, role, created_at, updated_at) VALUES ($1, $2, 'link_dm', $3::timestamptz, $3::timestamptz) RETURNING id`,
        [tenantId(), row.id, a.createdAt],
      );
      await t.query(
        `INSERT INTO template_variants (tenant_id, template_id, label, body, created_at, updated_at) VALUES ($1, $2, 'A', $3, $4::timestamptz, $4::timestamptz)`,
        [tenantId(), link.id, a.linkMessage, a.createdAt],
      );
    }
  }
}

async function writeThreads(t, sample, subjectHash) {
  for (const thread of sample.threads) {
    const messages = thread.messages;
    const last = messages.at(-1);
    const lastIn = messages.filter((m) => m.dir === 'in').at(-1);
    const lastBot = messages.filter((m) => m.author === 'automation').at(-1);
    const ownerReply = messages.filter((m) => m.author === 'owner').at(-1);
    const subject = subjectHash('instagram', thread.person);
    const [row] = await t.query(
      `INSERT INTO inbox_threads (tenant_id, channel, ig_user_id, subject_hash, recipient_id, username, last_message, last_message_at, last_user_message_at, last_bot_message_at,
         status, automation_paused_until, pause_reason, created_at, updated_at)
       VALUES ($1, 'instagram', $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, $11::timestamptz, $12, $13::timestamptz, $7::timestamptz) RETURNING id`,
      [tenantId(), sample.account.igUserId, subject, thread.person, thread.username, last.text, last.at, lastIn?.at ?? null, lastBot?.at ?? null, thread.status,
        thread.ownerReplied && ownerReply ? new Date(Date.parse(ownerReply.at) + 12 * 3_600_000).toISOString() : null,
        thread.ownerReplied ? 'thread.owner_replied' : '', messages[0].at],
    );
    await t.query(
      `INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, kind, text, mid, created_at)
       SELECT $1, $2, x.direction, x.author, x.kind, x.text, x.mid, x.created_at
       FROM jsonb_to_recordset($3::jsonb) AS x(direction text, author text, kind text, text text, mid text, created_at timestamptz)`,
      [tenantId(), row.id, json(messages.map((m) => ({ direction: m.dir, author: m.author, kind: m.kind, text: m.text, mid: m.dir === 'in' ? m.mid : null, created_at: m.at })))],
    );
    if (thread.handoff) {
      await t.query(
        `INSERT INTO needs_human_items (tenant_id, channel, thread_id, kind, reason, subject_hash, username, text, status, created_at)
         VALUES ($1, 'instagram', $2, 'handoff', 'thread.handoff', $3, $4, $5, 'open', $6::timestamptz)`,
        [tenantId(), row.id, subject, thread.username, lastIn?.text ?? '', lastIn?.at ?? last.at],
      );
    }
  }
}

async function writeOrders(t, sample, { productIds, pages }) {
  const ids = [];
  for (const o of sample.orders) {
    const page = o.pageSlug ? pages.get(o.pageSlug) : null;
    const c = o.customer;
    const address = { name: c.name, phone: c.phone, line1: c.line1, line2: '', landmark: '', city: c.city, stateCode: c.stateCode, pincode: c.pincode };
    const [order] = await t.query(
      `INSERT INTO orders (tenant_id, order_number, public_token, flow, payment_mode, reel_id, page_id, source, utm, customer_name, phone, email, address, city, state, pincode,
         shipping_address, subtotal_paise, discount_paise, loyalty_paise, shipping_paise, cod_fee_paise, tax_paise, total_paise, advance_paise, balance_paise,
         idempotency_key, terms_accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'checkout', $4, $5, $6, $7, $8::jsonb, $9, $10, '', $11, $12, $13, $14, $15::jsonb, $16, 0, 0, $17, $18, $19, $20, $21, $22, $23, $24::timestamptz, $24::timestamptz, $24::timestamptz)
       RETURNING id`,
      [tenantId(), o.orderNumber, o.token, o.mode, page?.mediaId ?? null, page?.id ?? null, page ? 'instagram_comment_dm' : 'direct',
        json(page ? { utm_source: 'instagram', utm_medium: 'dm', utm_campaign: 'festive-reel-price' } : {}),
        c.name, c.phone, c.line1, c.city, c.stateName, c.pincode, json(address), o.subtotalPaise, o.shippingPaise, o.codFeePaise, o.taxPaise, o.totalPaise,
        o.advancePaise, o.balancePaise, o.idempotencyKey, o.placedAt],
    );
    await t.query(
      `INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty, hsn_code, gst_rate_bp, tax_paise, weight_grams)
       SELECT $1, $2, x.product_id, x.name, x.price_paise, x.qty, x.hsn_code, x.gst_rate_bp, x.tax_paise, x.weight_grams
       FROM jsonb_to_recordset($3::jsonb) AS x(product_id integer, name text, price_paise bigint, qty integer, hsn_code text, gst_rate_bp integer, tax_paise bigint, weight_grams integer)`,
      [tenantId(), order.id, json(o.lines.map((l) => ({ product_id: productIds.get(l.productKey), name: l.name, price_paise: l.pricePaise, qty: l.qty, hsn_code: l.hsnCode, gst_rate_bp: l.gstRateBp, tax_paise: l.taxPaise, weight_grams: l.weightGrams })))],
    );
    for (const step of o.steps) {
      await changeOrder(t, order.id, { payment: step.payment, fulfilment: step.fulfilment, cancelReason: step.cancelReason, actor: ACTOR, reason: 'Sample order' });
    }
    await datePast(t, order.id, o);
    ids.push(order.id);
  }
  // The money columns that payments keep, as a payment that went through would have left them.
  return ids;
}

/**
 * The database stamps each move with the time it was made. A sample's moves happened over days, so its timeline, its
 * events and the order's own timestamps are set to when the sample says. No status column is written here.
 */
async function datePast(t, orderId, o) {
  const when = (pick) => o.steps.find(pick)?.at ?? null;
  await t.query(
    `UPDATE orders SET paid_paise = $3, confirmed_at = CASE WHEN confirmed_at IS NULL THEN NULL ELSE $4::timestamptz END,
       paid_at = CASE WHEN paid_at IS NULL THEN NULL ELSE COALESCE($5::timestamptz, $4::timestamptz) END,
       shipped_at = CASE WHEN shipped_at IS NULL THEN NULL ELSE $6::timestamptz END, delivered_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE $7::timestamptz END,
       cancelled_at = CASE WHEN cancelled_at IS NULL THEN NULL ELSE $8::timestamptz END
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), orderId, o.paidPaise, when((s) => s.fulfilment === 'new'), when((s) => s.payment === 'paid' || s.payment === 'advance_paid'),
      when((s) => s.fulfilment === 'shipped'), when((s) => s.fulfilment === 'delivered'), when((s) => s.fulfilment === 'cancelled')],
  );
  // The timeline: the creation row, then one row per move in order. History rows of one statement share a time, so they go in id order.
  const history = await t.query('SELECT id FROM order_status_history WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), orderId]);
  const times = [o.placedAt];
  for (const step of o.steps) {
    if (step.payment) times.push(step.at);
    if (step.fulfilment) times.push(step.at);
  }
  await t.query(
    `UPDATE order_status_history h SET created_at = x.at FROM jsonb_to_recordset($3::jsonb) AS x(id bigint, at timestamptz)
     WHERE h.tenant_id = $1 AND h.order_id = $2 AND h.id = x.id`,
    [tenantId(), orderId, json(history.map((h, i) => ({ id: h.id, at: times[Math.min(i, times.length - 1)] })))],
  );
  const events = await t.query('SELECT id FROM order_events WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), orderId]);
  await t.query(
    `UPDATE order_events e SET created_at = x.at, fanned_out_at = x.at FROM jsonb_to_recordset($3::jsonb) AS x(id bigint, at timestamptz)
     WHERE e.tenant_id = $1 AND e.order_id = $2 AND e.id = x.id`,
    [tenantId(), orderId, json(events.map((e, i) => ({ id: e.id, at: times[Math.min(i, times.length - 1)] })))],
  );
}

async function writeSettings(t, sample) {
  await t.query(
    `INSERT INTO settings (tenant_id, key, value) SELECT $1, x.key, x.value FROM jsonb_to_recordset($2::jsonb) AS x(key text, value text)`,
    [tenantId(), json([{ key: 'store_name', value: sample.business.name }])],
  );
}

/**
 * Writes the whole sample. `subjectHash(channel, personId)` is the business's keyed hash of a person's id, as the
 * compliance repo computes it. Returns how many of each thing it wrote.
 */
export async function writeSample(t, sample, { subjectHash }) {
  await writeSettings(t, sample);
  const productIds = await writeProducts(t, sample);
  const pages = await writePages(t, sample, productIds);
  const ref = await writeAccount(t, sample);
  await writeInsights(t, sample, ref);
  await writeAutomations(t, sample);
  await writeThreads(t, sample, subjectHash);
  const orders = await writeOrders(t, sample, { productIds, pages });
  // Orders were placed through the counter as checkout does, so the next real one follows them.
  await t.query('UPDATE tenants SET next_order_number = $2 WHERE id = $1', [tenantId(), sample.business.firstOrderNumber + orders.length]);
  return {
    products: productIds.size, pages: pages.size, orders: orders.length, automations: sample.automations.length,
    threads: sample.threads.length, insightDays: new Set(sample.insights.daily.map((r) => r.day)).size, media: sample.insights.media.length,
  };
}
