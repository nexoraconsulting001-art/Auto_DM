import { INDIAN_STATES } from '../../contracts/orders.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { readCursor, writeCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';
import { keyedHash, normalEmail } from '../shoppers/keys.js';

/**
 * A shopper's data requests at one business (PRD 9.18, S-63): seeing what is held (access) and having it erased.
 *
 * Erasure, in one transaction for the business:
 *   - orders keep their number, lines, amounts and the state of supply (tax records), with the name, phone, email, address
 *     and note blanked and erased_at set; their invoices keep every amount with the buyer masked and the file dropped, so
 *     it is drawn again from the masked copy;
 *   - return requests lose the shopper's words and their proof photos and videos (files too); reviews lose the name;
 *   - leads with the same phone or email go, with their channel consents;
 *   - the shopper row goes, and with it, through the foreign keys: sessions, addresses, carts, wishlist, points, cart
 *     reminders, this business's consent records for that account, and the link to the shared profile. The shared profile
 *     itself is the platform's (9.22) and is withdrawn from the shared-profile screen, not here.
 * The request row stays as the record that it was done, with counts only. While an order is still on its way, the
 * erasure waits: an address cannot be taken from a parcel in transit. The worker tries again.
 *
 * Erasure and access are per business: nothing here reads or changes another business's rows (RLS and tenant_id both).
 */
const OPEN_FULFILMENT = ['pending', 'new', 'packed', 'ready_to_ship', 'shipped', 'out_for_delivery', 'rto_initiated'];
const OPEN_RETURNS = ['requested', 'approved', 'pickup_scheduled', 'picked_up', 'received'];

/** The local 10-digit form an old order may hold, and the international one, for matching guest orders by phone. */
function phoneForms(phone) {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!digits) return [];
  const forms = new Set([`+${digits}`, digits]);
  if (digits.startsWith('91') && digits.length === 12) forms.add(digits.slice(2));
  return [...forms];
}

export function createDataRequests({ db, config, storage }) {
  const toRequest = (row) => ({
    id: Number(row.id), shopperId: row.shopper_id ?? null, kind: row.kind, status: row.status, source: row.source,
    summary: Object.fromEntries(Object.entries(row.summary ?? {}).map(([k, v]) => [k, Number(v) || 0])), requestedAt: row.requested_at, completedAt: row.completed_at ?? null,
  });

  /** The orders that are this shopper's at this business: their own, and guest orders with their verified number. */
  async function orderIdsOf(runner, shopper) {
    const forms = shopper.phone && shopper.phone_verified_at ? phoneForms(shopper.phone) : [];
    const rows = await runner.query(
      `SELECT id FROM orders WHERE tenant_id = $1 AND erased_at IS NULL AND (shopper_id = $2 OR (shopper_id IS NULL AND cardinality($3::text[]) > 0 AND phone = ANY($3::text[])))`,
      [tenantId(), shopper.id, forms],
    );
    return rows.map((r) => r.id);
  }

  async function openWork(runner, shopperId, orderIds) {
    const [o] = await runner.query(`SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND id = ANY($2::int[]) AND fulfilment_status = ANY($3::text[])`, [tenantId(), orderIds, OPEN_FULFILMENT]);
    const [r] = await runner.query(`SELECT count(*)::int AS n FROM returns WHERE tenant_id = $1 AND (order_id = ANY($2::int[]) OR shopper_id = $3) AND status = ANY($4::text[])`, [tenantId(), orderIds, shopperId, OPEN_RETURNS]);
    return o.n + r.n;
  }

  /** Runs one erasure inside `t`. Returns { done, summary, files } where files are storage keys to remove after commit. */
  async function erase(t, shopperId) {
    const [shopper] = await t.query('SELECT id, phone, phone_verified_at, email FROM shoppers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), shopperId]);
    if (!shopper) return { done: true, summary: { shoppers: 0 }, files: [] };
    const orderIds = await orderIdsOf(t, shopper);
    const open = await openWork(t, shopper.id, orderIds);
    if (open) return { done: false, summary: { waitingOnOrders: open }, files: [] };

    const summary = {};
    const files = [];
    const count = (name, rows) => {
      summary[name] = (summary[name] ?? 0) + rows.length;
      return rows;
    };

    // Orders are tax records: the money and the place of supply stay, the person goes.
    count('ordersMasked', await t.query(
      `UPDATE orders SET customer_name = '', phone = '', email = '', address = '', city = '', pincode = '', notes = '',
         shipping_address = CASE WHEN shipping_address IS NULL THEN NULL ELSE jsonb_build_object('stateCode', COALESCE(shipping_address->>'stateCode', '')) END,
         erased_at = now()
       WHERE tenant_id = $1 AND id = ANY($2::int[]) RETURNING id`,
      [tenantId(), orderIds],
    ));
    const invoices = await t.query('SELECT id, file_key FROM invoices WHERE tenant_id = $1 AND order_id = ANY($2::int[])', [tenantId(), orderIds]);
    for (const inv of invoices) if (inv.file_key) files.push(inv.file_key);
    count('invoicesMasked', await t.query(
      `UPDATE invoices SET buyer = jsonb_build_object('name', '', 'phone', '', 'address', '', 'stateCode', COALESCE(buyer->>'stateCode', '')), buyer_masked_at = now(), file_key = ''
       WHERE tenant_id = $1 AND order_id = ANY($2::int[]) RETURNING id`,
      [tenantId(), orderIds],
    ));

    const returnIds = (await t.query('SELECT id FROM returns WHERE tenant_id = $1 AND (order_id = ANY($2::int[]) OR shopper_id = $3)', [tenantId(), orderIds, shopper.id])).map((r) => r.id);
    const proofs = count('returnProofs', await t.query('DELETE FROM return_proofs WHERE tenant_id = $1 AND return_id = ANY($2::bigint[]) RETURNING file_key', [tenantId(), returnIds]));
    for (const p of proofs) files.push(p.file_key);
    count('returnsMasked', await t.query(`UPDATE returns SET reason = '', decline_note = '' WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND (reason <> '' OR decline_note <> '') RETURNING id`, [tenantId(), returnIds]));
    count('reviewsMasked', await t.query(`UPDATE reviews SET display_name = '' WHERE tenant_id = $1 AND (shopper_id = $2 OR order_id = ANY($3::int[])) AND display_name <> '' RETURNING id`, [tenantId(), shopper.id, orderIds]));

    const email = normalEmail(shopper.email);
    const leadPhones = shopper.phone && shopper.phone_verified_at ? [shopper.phone] : [];
    count('leads', await t.query(
      `DELETE FROM leads WHERE tenant_id = $1 AND ((cardinality($2::text[]) > 0 AND phone = ANY($2::text[])) OR ($3 <> '' AND lower(email) = $3)) RETURNING id`,
      [tenantId(), leadPhones, email],
    ));
    if (shopper.phone) {
      const hash = keyedHash(config, `phone:${tenantId()}`, shopper.phone);
      count('codes', await t.query('DELETE FROM shopper_otps WHERE tenant_id = $1 AND phone_hash = $2 RETURNING id', [tenantId(), hash]));
    }
    const [{ n: addresses }] = await t.query('SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), shopper.id]);
    summary.addresses = addresses;
    const [{ n: consents }] = await t.query('SELECT count(*)::int AS n FROM consent_records WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), shopper.id]);
    summary.consentRecords = consents;
    // The rest goes with the row, through the foreign keys (sessions, addresses, carts, saves, points, reminders, consent).
    count('shoppers', await t.query('DELETE FROM shoppers WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId(), shopper.id]));
    return { done: true, summary, files };
  }

  async function removeFiles(files) {
    for (const key of files) {
      // Only this business's own files, whatever a row says.
      if (typeof key === 'string' && key.startsWith(`t/${tenantId()}/`)) await storage.remove(key).catch(() => {});
    }
  }

  /** Works a request now: an erasure runs or waits for open orders, an access request is answered at once. */
  async function process(id, { actor = 'system' } = {}) {
    let files = [];
    const result = await db.tx(async (t) => {
      const [row] = await t.query(`SELECT * FROM data_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId(), id]);
      if (!row || !['requested', 'processing'].includes(row.status)) return row;
      if (row.kind !== 'erasure') return row;
      if (!row.shopper_id) {
        const [done] = await t.query(`UPDATE data_requests SET status = 'completed', completed_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId(), id]);
        return done;
      }
      const shopperId = row.shopper_id;
      const outcome = await erase(t, shopperId);
      if (!outcome.done) {
        const [waiting] = await t.query(`UPDATE data_requests SET status = 'requested', summary = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId(), id, JSON.stringify(outcome.summary)]);
        return waiting;
      }
      files = outcome.files;
      const [done] = await t.query(`UPDATE data_requests SET status = 'completed', summary = $3, completed_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId(), id, JSON.stringify(outcome.summary)]);
      await writeAudit(t, { actor, action: 'shopper.erased', target: `data_request:${id}`, details: outcome.summary });
      return done;
    });
    await removeFiles(files);
    if (result?.status === 'completed' && result.kind === 'erasure') log.info('shopper.erasure_completed', { requestId: Number(id) });
    return result ? toRequest(result) : null;
  }

  /** Everything this business holds about one shopper, as plain JSON for them to keep (access). */
  async function collect(shopperId) {
    const [shopper] = await db.query('SELECT id, phone, phone_verified_at, google_sub, email, name, created_at FROM shoppers WHERE tenant_id = $1 AND id = $2', [tenantId(), shopperId]);
    if (!shopper) return null;
    const [business] = await db.query('SELECT name FROM tenants WHERE id = $1', [tenantId()]);
    const addresses = await db.query('SELECT name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default, created_at FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id', [tenantId(), shopperId]);
    const orders = await db.query(
      `SELECT id, order_number, created_at, fulfilment_status, payment_status, payment_mode, total_paise, customer_name, phone, email, shipping_address
       FROM orders WHERE tenant_id = $1 AND shopper_id = $2 AND erased_at IS NULL ORDER BY id`,
      [tenantId(), shopperId],
    );
    const items = orders.length ? await db.query('SELECT order_id, name, option_value, qty, price_paise FROM order_items WHERE tenant_id = $1 AND order_id = ANY($2::int[]) ORDER BY id', [tenantId(), orders.map((o) => o.id)]) : [];
    const consent = await db.query('SELECT purpose, channel, granted, notice_version, source, created_at FROM consent_records WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id', [tenantId(), shopperId]);
    const reviews = await db.query('SELECT product_id, rating, body, display_name, created_at FROM reviews WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id', [tenantId(), shopperId]);
    const saved = await db.query('SELECT p.name FROM wishlist_items w JOIN products p ON p.tenant_id = w.tenant_id AND p.id = w.product_id WHERE w.tenant_id = $1 AND w.shopper_id = $2', [tenantId(), shopperId]);
    return {
      store: business?.name ?? '',
      generatedAt: new Date().toISOString(),
      account: { name: shopper.name, phone: shopper.phone ?? '', phoneVerified: Boolean(shopper.phone_verified_at), email: shopper.email, signsInWithGoogle: Boolean(shopper.google_sub), since: shopper.created_at },
      addresses: addresses.map((a) => ({ name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, state: INDIAN_STATES[a.state_code] ?? a.state_code, pincode: a.pincode, kind: a.kind, isDefault: a.is_default })),
      orders: orders.map((o) => ({
        number: o.order_number, placedAt: o.created_at, status: o.fulfilment_status, payment: o.payment_status, paidBy: o.payment_mode, totalPaise: Number(o.total_paise),
        name: o.customer_name, phone: o.phone, email: o.email, deliveryAddress: o.shipping_address ?? null,
        items: items.filter((i) => i.order_id === o.id).map((i) => ({ name: i.name, option: i.option_value, qty: i.qty, pricePaise: Number(i.price_paise) })),
      })),
      consent: consent.map((c) => ({ purpose: c.purpose, channel: c.channel, granted: c.granted, noticeVersion: c.notice_version, where: c.source, at: c.created_at })),
      reviews: reviews.map((r) => ({ productId: r.product_id, rating: r.rating, text: r.body, shownAs: r.display_name, at: r.created_at })),
      wishlist: saved.map((s) => s.name),
    };
  }

  return {
    toRequest,

    /** A new request. An access request from the shopper comes back with the data; an erasure is worked at once (or waits). */
    async create({ shopperId, kind, source, actor }) {
      const [shopper] = await db.query('SELECT id FROM shoppers WHERE tenant_id = $1 AND id = $2', [tenantId(), shopperId]);
      if (!shopper) return null;
      const [row] = await db.query(
        `INSERT INTO data_requests (tenant_id, shopper_id, kind, status, source) VALUES ($1, $2, $3, 'processing', $4) RETURNING *`,
        [tenantId(), shopperId, kind, source],
      );
      if (kind === 'access') {
        const data = await collect(shopperId);
        const summary = { addresses: data?.addresses.length ?? 0, orders: data?.orders.length ?? 0, consentRecords: data?.consent.length ?? 0 };
        const [done] = await db.query(`UPDATE data_requests SET status = 'completed', summary = $3, completed_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId(), row.id, JSON.stringify(summary)]);
        return { request: toRequest(done), data };
      }
      await writeAudit(db, { actor, action: 'shopper.erasure_requested', target: `data_request:${row.id}`, details: { source } });
      return { request: await process(row.id, { actor }) };
    },

    process,

    async list({ cursor, limit, status }) {
      const after = cursor ? readCursor(cursor, (k) => k.length === 1 && Number.isSafeInteger(k[0]) && k[0] > 0)[0] : null;
      const statuses = status === 'open' ? ['requested', 'processing'] : status === 'completed' ? ['completed', 'rejected'] : ['requested', 'processing', 'completed', 'rejected'];
      const rows = await db.query(
        'SELECT * FROM data_requests WHERE tenant_id = $1 AND status = ANY($2::text[]) AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4',
        [tenantId(), statuses, after, limit + 1],
      );
      const shown = rows.slice(0, limit);
      return { items: shown.map(toRequest), nextCursor: rows.length > limit ? writeCursor([Number(shown.at(-1).id)]) : null };
    },

    async get(id) {
      const [row] = await db.query('SELECT * FROM data_requests WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return row ? toRequest(row) : null;
    },
  };
}

/** Erasures still waiting, across businesses: the worker's list (platform path; the work itself runs inside each business). */
export async function waitingErasures(db, limit = 100) {
  return (db.platform ?? db).query(
    `SELECT tenant_id, id FROM data_requests WHERE kind = 'erasure' AND status IN ('requested', 'processing') ORDER BY requested_at LIMIT $1`,
    [limit],
  );
}
