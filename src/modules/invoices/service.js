import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { INDIAN_STATES, stateCodeOf } from '../../contracts/orders.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { buyerTheme } from '../../views/buyer/theme.js';
import { alertsRepo } from '../alerts/index.js';
import { writeAudit } from '../audit/index.js';
import { returnForRefund } from '../returns/links.js';
import { creditNoteLines, invoiceLines, totalsOf } from './money.js';
import { invoicePdf } from './pdf.js';

/**
 * GST invoices and credit notes (PRD 9.13), for one process's ctx.
 *
 *   settings.get() / settings.update(patch)   legal name, GSTIN, state and prefix (invoice_settings)
 *   issueFor(orderId, { force })              the order's invoice, issued if it is due and not yet issued -> { invoice, created } | null
 *   creditNoteFor(refundId)                   the refund's credit note, issued once it is processed -> { invoice, created } | null
 *   onEvent(event)                            the order event listener: order.paid / advance_paid / delivered, refund.processed
 *   list({ cursor, limit, orderId }) / get(id)   the console's
 *   file(invoice)                             the PDF: from storage, or drawn again from the row -> Buffer
 *   storeFile(invoiceId)                      the queue job: draws the PDF and keeps it in storage
 *   sweep()                                   documents still without a file, across businesses, queued again
 *
 * The database numbers every document: gapless per business, kind and financial year, a second document for the same
 * order or refund refused (migration 408). Code never picks a number and never inserts with ON CONFLICT. An issued row
 * never changes except its file and a masked buyer.
 *
 * When it is due (9.13): prepaid on payment, part-advance when the advance is paid (both parts shown), cash on delivery on
 * delivery or when the cash is collected, whichever is first. A refund's credit note issues the invoice first if it is
 * somehow still missing, since money was taken.
 */
export const PDF_QUEUE = 'invoices.pdf';
export const SWEEP_QUEUE = 'invoices.pdf-sweep';
export const INVOICE_EVENTS = Object.freeze(['order.paid', 'order.advance_paid', 'order.delivered', 'refund.processed']);

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const STATE = /^[0-9]{2}$/;
const PAID = ['paid', 'partially_refunded', 'refunded'];
const DEFAULTS = Object.freeze({ legal_name: '', gstin: '', state_code: '', address: '', invoice_prefix: 'INV' });

const isState = (code) => typeof code === 'string' && STATE.test(code) && Object.hasOwn(INDIAN_STATES, code);

/** Whether an order's invoice is due now. */
export function invoiceDue(order) {
  if (!order || order.flow !== 'checkout') return false;
  if (order.payment_mode === 'prepaid') return PAID.includes(order.payment_status);
  if (order.payment_mode === 'part_advance') return ['advance_paid', ...PAID].includes(order.payment_status);
  if (order.payment_mode === 'cod') return order.fulfilment_status === 'delivered' || PAID.includes(order.payment_status);
  return false;
}

export const toSettings = (row) => ({ legalName: row.legal_name, gstin: row.gstin, stateCode: row.state_code, address: row.address, invoicePrefix: row.invoice_prefix });

/** The console's view of a document. */
export const toInvoice = (row) => ({
  id: Number(row.id),
  orderId: row.order_id,
  docType: row.doc_type,
  number: row.number,
  issuedAt: row.issued_at,
  taxablePaise: Number(row.taxable_paise),
  cgstPaise: Number(row.cgst_paise),
  sgstPaise: Number(row.sgst_paise),
  igstPaise: Number(row.igst_paise),
  totalPaise: Number(row.total_paise),
  advancePaise: Number(row.advance_paise),
  balancePaise: Number(row.balance_paise),
  originalInvoiceId: row.original_invoice_id === null ? null : Number(row.original_invoice_id),
  fileUrl: `/invoices/${Number(row.id)}/file`,
});

/** What a document's file is called when downloaded: INV-26-27-00001.pdf. */
export const fileName = (number) => `${String(number).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;

/** The order's address, as one line, and its state. */
function buyerOf(order) {
  const a = order.shipping_address ?? {};
  const parts = [a.line1, a.line2, a.landmark, a.city, a.pincode].map((s) => String(s ?? '').trim()).filter(Boolean);
  const stateCode = isState(a.stateCode) ? a.stateCode : stateCodeOf(order.state) ?? '';
  return {
    name: String(a.name ?? order.customer_name ?? '').slice(0, 120),
    phone: String(a.phone ?? order.phone ?? '').slice(0, 20),
    address: parts.join(', ').slice(0, 400),
    stateCode,
  };
}

export function createInvoices(ctx) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;
  const storage = () => ctx.platform.storage;
  const queue = () => ctx.platform.queue;

  async function readSettings(q = db) {
    const [row] = await q.query('SELECT * FROM invoice_settings WHERE tenant_id = $1', [tenantId()]);
    if (row) return row;
    // Before the owner saves these, the Phase 0 GSTIN setting is the seller's, if it is a real one.
    const [old] = await q.query(`SELECT value FROM settings WHERE tenant_id = $1 AND key = 'gstin'`, [tenantId()]);
    const gstin = String(old?.value ?? '').trim().toUpperCase();
    return { ...DEFAULTS, gstin: GSTIN.test(gstin) ? gstin : '', state_code: GSTIN.test(gstin) ? gstin.slice(0, 2) : '' };
  }

  const settings = {
    get: async () => toSettings(await readSettings()),
    async update(patch, actor) {
      const current = await readSettings();
      const next = {
        legal_name: patch.legalName ?? current.legal_name,
        gstin: patch.gstin ?? current.gstin,
        state_code: patch.stateCode ?? current.state_code,
        address: patch.address ?? current.address,
        invoice_prefix: patch.invoicePrefix ?? current.invoice_prefix,
      };
      // A GSTIN names its state in its first two digits: the state must agree, and follows it when not given.
      if (next.gstin) {
        const fromGstin = next.gstin.slice(0, 2);
        if (!isState(fromGstin)) throw new ApiError('validation_failed', 'That GSTIN doesn’t start with an Indian state code.', { fields: { gstin: 'Enter a valid GSTIN' } });
        if (patch.stateCode === undefined && next.state_code !== fromGstin) next.state_code = fromGstin;
        if (next.state_code !== fromGstin) throw new ApiError('validation_failed', 'The state must be the one your GSTIN is registered in.', { fields: { stateCode: 'Pick the state of your GSTIN' } });
      }
      if (next.state_code && !isState(next.state_code)) throw new ApiError('validation_failed', 'Pick a state', { fields: { stateCode: 'Pick a state' } });
      const row = await db.tx(async (t) => {
        const [saved] = await t.query(
          `INSERT INTO invoice_settings (tenant_id, legal_name, gstin, state_code, address, invoice_prefix, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (tenant_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, gstin = EXCLUDED.gstin, state_code = EXCLUDED.state_code,
             address = EXCLUDED.address, invoice_prefix = EXCLUDED.invoice_prefix, updated_at = now()
           RETURNING *`,
          [tenantId(), next.legal_name, next.gstin, next.state_code, next.address, next.invoice_prefix],
        );
        const changed = Object.keys(next).filter((k) => next[k] !== current[k]);
        if (changed.length) await writeAudit(t, { actor, action: 'invoice_settings.update', target: 'invoice_settings', details: { changed } });
        return saved;
      });
      return toSettings(row);
    },
  };

  /** The store's name and colour for the PDF's heading. */
  async function brandOf() {
    const [all, kit] = await Promise.all([ctx.repos.settings.getAll(), ctx.repos.brandKit.get().catch(() => ({}))]);
    const theme = buyerTheme(kit ?? {});
    return { name: all.store_name, color: theme.colors?.primary };
  }

  /** Inside `t` with the order locked: the invoice, issued if due (or forced). */
  async function issueIn(t, order, { force = false } = {}) {
    const [existing] = await t.query(`SELECT * FROM invoices WHERE tenant_id = $1 AND order_id = $2 AND doc_type <> 'credit_note'`, [tenantId(), order.id]);
    if (existing) return { invoice: existing, created: false };
    if (order.flow !== 'checkout' || (!force && !invoiceDue(order))) return null;
    const items = await t.query(
      'SELECT id, name, option_value, hsn_code, qty, price_paise, discount_paise, gst_rate_bp FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id',
      [tenantId(), order.id],
    );
    if (!items.length) return null;
    const s = await readSettings(t);
    const [store] = await t.query(`SELECT value FROM settings WHERE tenant_id = $1 AND key = 'store_name'`, [tenantId()]);
    const registered = GSTIN.test(s.gstin);
    const sellerState = isState(s.state_code) ? s.state_code : registered ? s.gstin.slice(0, 2) : '';
    const buyer = buyerOf(order);
    const placeOfSupply = isState(buyer.stateCode) ? buyer.stateCode : sellerState || '97';
    const lines = invoiceLines({
      items: items.map((i) => ({ id: i.id, name: i.name, option: i.option_value, hsn: i.hsn_code, qty: i.qty, pricePaise: Number(i.price_paise), discountPaise: Number(i.discount_paise), rateBp: i.gst_rate_bp })),
      shippingPaise: Number(order.shipping_paise),
      codFeePaise: Number(order.cod_fee_paise),
      registered,
      sellerState,
      placeOfSupply,
    });
    const totals = totalsOf(lines);
    const seller = { legalName: s.legal_name || String(store?.value ?? ''), gstin: registered ? s.gstin : '', stateCode: sellerState, address: s.address };
    const advance = order.payment_mode === 'part_advance' ? { advance: Number(order.advance_paise), balance: Number(order.balance_paise) } : { advance: 0, balance: 0 };
    // fy, seq and number are the database's: whatever is written here is replaced by the trigger.
    const [invoice] = await t.query(
      `INSERT INTO invoices (tenant_id, order_id, doc_type, fy, seq, number, seller, buyer, place_of_supply, lines,
         taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, advance_paise, balance_paise)
       VALUES ($1, $2, $3, 0, 0, '', $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [tenantId(), order.id, registered ? 'invoice' : 'bill_of_supply', JSON.stringify(seller), JSON.stringify(buyer), placeOfSupply, JSON.stringify(lines),
        totals.taxablePaise, totals.cgstPaise, totals.sgstPaise, totals.igstPaise, totals.totalPaise, advance.advance, advance.balance],
    );
    await ctx.orderEvents?.emit(t, { type: 'invoice.issued', orderId: order.id, entity: 'invoice', entityId: Number(invoice.id), dedupeKey: `invoice.issued:${invoice.id}` });
    return { invoice, created: true };
  }

  async function lockOrder(t, orderId) {
    const id = Number(orderId);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return null;
    const [order] = await t.query('SELECT * FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), id]);
    return order ?? null;
  }

  /** After commit: the PDF is drawn by the queue. */
  async function queuePdf(invoice) {
    try {
      await queue().enqueue(PDF_QUEUE, { invoiceId: Number(invoice.id) }, { tenantId: tenantId(), dedupeKey: `invoice-pdf:${tenantId()}:${invoice.id}`, maxAttempts: 5 });
    } catch (err) {
      // The sweep finds documents still without a file, so a lost enqueue only delays it.
      log.warn('invoices.pdf_enqueue_failed', { invoiceId: Number(invoice.id), error: err.code ?? 'error' });
    }
  }

  /** Runs `work(t)` and, when it refuses with the database's own "already issued", reads what is there instead. */
  async function once(work, reread) {
    try {
      return await db.tx(work);
    } catch (err) {
      if (err?.code === '23505' && /^invoices_(order|refund)_idx$/.test(err.constraint ?? '')) {
        const row = await reread();
        if (row) return { invoice: row, created: false };
      }
      throw err;
    }
  }

  async function issueFor(orderId, { force = false } = {}) {
    const result = await once(async (t) => {
      const order = await lockOrder(t, orderId);
      return order ? issueIn(t, order, { force }) : null;
    }, async () => (await db.query(`SELECT * FROM invoices WHERE tenant_id = $1 AND order_id = $2 AND doc_type <> 'credit_note'`, [tenantId(), Number(orderId)]))[0]);
    if (result?.created) {
      log.info('invoices.issued', { invoiceId: Number(result.invoice.id), orderId: result.invoice.order_id, docType: result.invoice.doc_type });
      await queuePdf(result.invoice);
      ctx.orderEvents?.kick?.();
    }
    return result;
  }

  async function creditNoteFor(refundId) {
    const id = Number(refundId);
    let issuedInvoice = null;
    const result = await once(async (t) => {
      const [found] = await t.query('SELECT order_id FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      if (!found) return null;
      const order = await lockOrder(t, found.order_id);
      const [refund] = await t.query('SELECT * FROM refunds WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      if (!order || refund.status !== 'processed') return null;
      const [existing] = await t.query('SELECT * FROM invoices WHERE tenant_id = $1 AND refund_id = $2', [tenantId(), id]);
      if (existing) return { invoice: existing, created: false };
      // Money was taken and given back: the sale's own document comes first, if it is somehow missing.
      const issued = await issueIn(t, order, { force: true });
      if (!issued) return null;
      if (issued.created) issuedInvoice = issued.invoice;
      const invoice = issued.invoice;
      const earlier = await t.query(`SELECT lines FROM invoices WHERE tenant_id = $1 AND original_invoice_id = $2 AND doc_type = 'credit_note' ORDER BY id`, [tenantId(), invoice.id]);
      // A refund for a return gives back the returned units first.
      const prefer = {};
      const qty = {};
      const ret = await returnForRefund(t, refund);
      if (ret) {
        const returned = await t.query('SELECT order_item_id, qty FROM return_items WHERE tenant_id = $1 AND return_id = $2', [tenantId(), ret.id]);
        invoice.lines.forEach((line, i) => {
          const r = returned.find((x) => x.order_item_id === line.orderItemId);
          if (!r || !line.qty) return;
          prefer[i] = Math.floor(((line.grossPaise - (line.discountPaise ?? 0)) * Math.min(r.qty, line.qty)) / line.qty);
          qty[i] = Math.min(r.qty, line.qty);
        });
      }
      const amount = Number(refund.amount_paise);
      let lines;
      try {
        lines = creditNoteLines({
          invoice: { lines: invoice.lines, placeOfSupply: invoice.place_of_supply, sellerState: invoice.seller?.stateCode ?? '', registered: invoice.doc_type === 'invoice' },
          earlier: earlier.flatMap((row) => row.lines),
          amountPaise: amount,
          prefer,
          qty,
        });
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        // More refunded than the invoice holds: trying again won't change that, so a person is told instead.
        await alertsRepo(t).raise({ kind: 'invoice.credit_mismatch', severity: 'critical', audience: 'ops', target: `order:${order.id}`, dedupeKey: `credit-mismatch:${id}`, message: `A refund on order ${order.order_number} is more than is left on its invoice ${invoice.number}, so no credit note was issued. Check the order.` });
        log.warn('invoices.credit_mismatch', { orderId: order.id, refundId: id, invoiceId: Number(invoice.id) });
        return { invoice: null, created: false, mismatch: true };
      }
      const totals = totalsOf(lines);
      const [note] = await t.query(
        `INSERT INTO invoices (tenant_id, order_id, doc_type, fy, seq, number, refund_id, original_invoice_id, seller, buyer, place_of_supply, lines,
           taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
         VALUES ($1, $2, 'credit_note', 0, 0, '', $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13) RETURNING *`,
        [tenantId(), order.id, id, invoice.id, JSON.stringify(invoice.seller), JSON.stringify(invoice.buyer), invoice.place_of_supply, JSON.stringify(lines),
          totals.taxablePaise, totals.cgstPaise, totals.sgstPaise, totals.igstPaise, totals.totalPaise],
      );
      await ctx.orderEvents?.emit(t, { type: 'credit_note.issued', orderId: order.id, entity: 'credit_note', entityId: Number(note.id), dedupeKey: `credit_note.issued:${note.id}` });
      return { invoice: note, created: true };
    }, async () => (await db.query('SELECT * FROM invoices WHERE tenant_id = $1 AND refund_id = $2', [tenantId(), id]))[0]);
    if (issuedInvoice) await queuePdf(issuedInvoice);
    if (result?.created) {
      log.info('invoices.credit_note_issued', { invoiceId: Number(result.invoice.id), orderId: result.invoice.order_id, refundId: id });
      await queuePdf(result.invoice);
      ctx.orderEvents?.kick?.();
    }
    return result;
  }

  async function onEvent(event) {
    if (event.type === 'refund.processed') return creditNoteFor(event.entityId);
    return issueFor(event.orderId);
  }

  async function list({ cursor, limit = 25, orderId } = {}) {
    const after = cursor && /^\d{1,19}$/.test(cursor) ? cursor : null;
    const rows = await db.query(
      `SELECT * FROM invoices WHERE tenant_id = $1 AND ($2::int IS NULL OR order_id = $2) AND ($3::bigint IS NULL OR id < $3::bigint)
       ORDER BY id DESC LIMIT $4`,
      [tenantId(), orderId ?? null, after, limit + 1],
    );
    const items = rows.slice(0, limit).map(toInvoice);
    return { items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null };
  }

  async function row(id) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    return (await db.query('SELECT * FROM invoices WHERE tenant_id = $1 AND id = $2', [tenantId(), n]))[0] ?? null;
  }

  const get = async (id) => {
    const found = await row(id);
    return found ? toInvoice(found) : null;
  };

  /** Draws the document from its row. */
  async function draw(invoice) {
    const [order] = await db.query('SELECT order_number, loyalty_paise, total_paise FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), invoice.order_id]);
    const original = invoice.original_invoice_id ? (await db.query('SELECT number, issued_at FROM invoices WHERE tenant_id = $1 AND id = $2', [tenantId(), invoice.original_invoice_id]))[0] : null;
    return invoicePdf({
      invoice,
      brand: await brandOf(),
      order: { orderNumber: order?.order_number ?? '', loyaltyPaise: Number(order?.loyalty_paise ?? 0), totalPaise: Number(order?.total_paise ?? 0) },
      original,
    });
  }

  /** The PDF of a document: the stored file, or drawn again from the row (the queue may not have run yet). */
  async function file(invoice) {
    if (invoice.file_key) {
      const stored = await storage().get(invoice.file_key).catch(() => null);
      if (stored) return stored;
    }
    if (!invoice.file_key) await queuePdf(invoice);
    return draw(invoice);
  }

  /** The queue job: draws the PDF and keeps it in the business's storage. Safe to run twice. */
  async function storeFile(invoiceId) {
    const invoice = await row(invoiceId);
    if (!invoice || invoice.file_key) return false;
    const buffer = await draw(invoice);
    const key = `t/${tenantId()}/invoices/${Number(invoice.id)}-${crypto.randomBytes(6).toString('hex')}.pdf`;
    await storage().put(key, buffer, 'application/pdf');
    // Only if the buyer is still as drawn: a deletion request that masked it in the meantime gets a fresh drawing.
    const [kept] = await db.query(
      `UPDATE invoices SET file_key = $3 WHERE tenant_id = $1 AND id = $2 AND file_key = '' AND buyer = $4::jsonb RETURNING id`,
      [tenantId(), invoice.id, key, JSON.stringify(invoice.buyer)],
    );
    if (!kept) {
      await storage().remove(key).catch(() => {});
      const again = await row(invoiceId);
      if (again && !again.file_key) throw new Error('The invoice changed while its file was drawn; trying again');
      return false;
    }
    return true;
  }

  /** Documents a minute old or more with no file yet, across businesses: queued again (a lost enqueue, a masked buyer). */
  async function sweep({ limit = 200 } = {}) {
    const due = await platformDb.query(
      `SELECT tenant_id, id FROM invoices WHERE file_key = '' AND created_at < now() - interval '1 minute' ORDER BY id LIMIT $1`,
      [limit],
    );
    const slot = Math.floor(Date.now() / 3_600_000);
    for (const r of due) {
      await queue().enqueue(PDF_QUEUE, { invoiceId: Number(r.id) }, { tenantId: r.tenant_id, dedupeKey: `invoice-pdf:${r.tenant_id}:${r.id}:${slot}`, maxAttempts: 5 });
    }
    return due.length;
  }

  /** The buyer's document by the order's link and its number, or null. */
  async function forBuyer(token, number) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(token) || typeof number !== 'string' || number.length > 16 || !/^[A-Z0-9/-]+$/.test(number)) return null;
    const [found] = await db.query(
      `SELECT i.* FROM invoices i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
       WHERE i.tenant_id = $1 AND o.public_token = $2 AND i.number = $3`,
      [tenantId(), token, number],
    );
    return found ?? null;
  }

  return { settings, issueFor, creditNoteFor, onEvent, list, get, row, file, storeFile, sweep, forBuyer, draw };
}
