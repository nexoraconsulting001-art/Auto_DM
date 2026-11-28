import crypto from 'node:crypto';
import { ProviderError } from '../../adapters/http.js';
import { ApiError, planOff } from '../../contracts/api/index.js';
import { financialYearOf, planRank, usageMonthOf } from '../../contracts/billing.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { alertsRepo } from '../alerts/index.js';
import { writeAudit } from '../audit/index.js';
import { opsAlert } from '../payments/util.js';
import { notePaymentMethod } from '../referrals/service.js';
import { creditLines, discountFor, taxedLine, totalsOf } from './money.js';

/**
 * Bhava's own billing (PRD 3, 5.12), for one process's ctx. Prices, add-ons, the offer and every open rule are rows
 * (migration 700); nothing here names a price. No method takes an amount, a price or a discount from a caller.
 *
 *   catalog() / plan()                         what the owner may buy, and what the business is on
 *   change({ plan, cycle }, user)              an upgrade now; a downgrade or a cycle change at the period's end
 *   addItem({ code, quantity, requestKey }, user) / removeItem(id, user)
 *   invoices.list(query) / invoices.get(id)    Bhava's invoices and credit notes to this business
 *   applyCharge / applyFailure / ...           what the provider's webhooks do (webhooks.js routes them here)
 *   renewals()                                 queues the next period's add-on lines and the month's pass-through charges
 *   graceSweep()                               reminders during grace, then the owner-locked pause (or Free) after it
 *   platform.*                                 the Platform Console's view and overrides (platform.js)
 *
 * Every change of state runs in one transaction under a per-business advisory lock, so two requests or a request and a
 * webhook for one business are applied one after the other. Inside such a transaction nothing but that transaction is used:
 * the database handle, the platform handle and the repos wait for it (one connection in tests). The provider is called inside
 * it where its answer decides what is written: a new subscription, and a queued add-on line (queueItem), whose "find by key,
 * else add" at the provider is not one step and so must never run twice at once for one line.
 */
const LOCK_SPACE = 70_701;
const DAY = 86_400_000;
/** A recurring line is queued with the provider this long before the period it pays for starts. */
export const QUEUE_AHEAD_MS = DAY;
const LIVE = ['active', 'past_due', 'grace'];
const PASS_THROUGH_METERS = Object.freeze({ whatsapp_messages: { kind: 'whatsapp', name: 'WhatsApp messages, at cost' }, ai_units: { kind: 'ai', name: 'AI usage, at cost' } });
/**
 * The pass-through kinds billed on Bhava's invoice (collected_by 'invoice'): the provider charge's name and the invoice line's
 * label. Shipping is here only for a seller billed monthly for its courier charges (shipping_settings.charge_billing).
 */
const INVOICED_PASS_THROUGH = Object.freeze({
  whatsapp: { name: 'WhatsApp messages, at cost', label: 'WhatsApp messages' },
  ai: { name: 'AI usage, at cost', label: 'AI usage' },
  shipping: { name: 'Shipping, at cost', label: 'Shipping' },
});

const iso = (value) => (value ? new Date(value).toISOString() : null);
const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
/** The moment a usage month ('YYYY-MM') closes, in India: the first instant of the next month. */
const monthEnd = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1) - 330 * 60_000);
};
const n = (value) => (value === null || value === undefined ? null : Number(value));
const monthsOf = (cycle) => (cycle === 'yearly' ? 12 : 1);

/** Turns a provider failure into the API's answer; anything else as it was. */
export function providerFailure(err) {
  if (!(err instanceof ProviderError)) return err;
  log.warn('billing.provider_failed', { kind: err.kind, status: err.status, code: err.code, delivery: err.delivery });
  return new ApiError('conflict', 'The payment provider didn’t answer. Please try again in a minute.', { reason: 'provider' });
}

export function createBilling(ctx, { now = () => new Date() } = {}) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;
  const provider = () => ctx.providers.razorpay.billing;
  const at = () => new Date(now());

  const lock = (t) => t.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_SPACE, tenantId()]);
  /** One transaction for the current business, under its billing lock. */
  const locked = (fn) => db.tx(async (t) => {
    await lock(t);
    return fn(t);
  });

  // ---- reading ----

  const settingsOf = async (q) => (await q.query('SELECT * FROM billing_settings LIMIT 1'))[0];
  const complete = (s) => Boolean(s?.legal_name && s.state_code && s.sac);
  const tenantOf = async (q) => (await q.query('SELECT id, name, legal_name, plan, billing_cycle FROM tenants WHERE id = $1', [tenantId()]))[0];
  const subOf = async (q, { forUpdate = false } = {}) => (await q.query(`SELECT * FROM subscriptions WHERE tenant_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [tenantId()]))[0] ?? null;
  const planOf = async (q, code) => (await q.query('SELECT code, name, rank FROM plans WHERE code = $1', [code]))[0] ?? null;
  const priceOf = async (q, plan, cycle) => (await q.query('SELECT amount_paise FROM plan_prices WHERE plan_code = $1 AND cycle = $2', [plan, cycle]))[0];
  const offerRow = async (q, code) => (code ? (await q.query('SELECT * FROM offers WHERE code = $1', [code]))[0] ?? null : null);
  const asOffer = (row) => (row ? { code: row.code, name: row.name, percentOff: Number(row.percent_off), forLife: Boolean(row.for_life), appliesTo: row.applies_to } : null);

  /** Who the business is on an invoice, and where it is supplied: its invoice settings, else its name and Bhava's state. */
  async function buyerOf(q, settings) {
    const t = await tenantOf(q);
    const [own] = await q.query('SELECT legal_name, gstin, state_code, address FROM invoice_settings WHERE tenant_id = $1', [tenantId()]);
    const stateCode = own?.state_code || settings.state_code || '';
    return { legalName: own?.legal_name || t.legal_name || t.name, gstin: own?.gstin ?? '', stateCode, address: own?.address ?? '' };
  }
  const sellerOf = (s) => ({ legalName: s.legal_name, gstin: s.gstin, stateCode: s.state_code, address: s.address });

  /** The plan's line for one cycle, after the offer. */
  async function planLine(q, { plan, cycle, offer, settings, placeOfSupply, periodStart = null, periodEnd = null }) {
    const price = await priceOf(q, plan, cycle);
    const info = await planOf(q, plan);
    if (!price || !info) throw new ApiError('validation_failed', 'Choose a plan.', { fields: { plan: 'Choose a plan' } });
    const gross = Number(price.amount_paise);
    return taxedLine({
      kind: 'plan', code: plan, description: `${info.name} plan, ${cycle === 'yearly' ? 'yearly (12 months for the price of 10)' : 'monthly'}`, sac: settings.sac,
      quantity: 1, unitPaise: gross, grossPaise: gross, discountPaise: discountFor(gross, offer), rateBp: settings.tax_rate_bp,
      sellerState: settings.state_code, placeOfSupply, periodStart, periodEnd,
    });
  }

  /** An add-on's line: its own price at purchase, times quantity, times the months of the cycle it renews with. */
  function itemLine(item, addon, { offer, settings, placeOfSupply, months = 1 }) {
    const quantity = Number(item.quantity) * (item.cycle === 'monthly' ? months : 1);
    const unit = Number(item.unit_price_paise);
    const gross = unit * quantity;
    const discount = offer?.appliesTo === 'plan_and_addons' ? discountFor(gross, offer) : 0;
    return taxedLine({
      kind: item.kind, code: item.addon_code, description: `${addon?.name ?? item.addon_code}${item.cycle === 'monthly' && months > 1 ? `, ${months} months` : ''}`, sac: settings.sac,
      quantity, unitPaise: unit, grossPaise: gross, discountPaise: discount, rateBp: settings.tax_rate_bp, sellerState: settings.state_code, placeOfSupply,
    });
  }

  // ---- the provider's plans ----

  /** The provider's plan id for one charge amount, made once and kept in provider_plans (a platform table). */
  async function providerPlan({ plan, cycle, amountPaise, name }) {
    const [found] = await platformDb.query(`SELECT provider_plan_id FROM provider_plans WHERE provider = 'razorpay' AND plan_code = $1 AND cycle = $2 AND amount_paise = $3`, [plan, cycle, amountPaise]);
    if (found) return found.provider_plan_id;
    const made = await provider().ensurePlan({ code: plan, cycle, amountPaise, name });
    await platformDb.query(
      `INSERT INTO provider_plans (provider, plan_code, cycle, amount_paise, provider_plan_id) VALUES ('razorpay', $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [plan, cycle, amountPaise, made.id],
    );
    const [kept] = await platformDb.query(`SELECT provider_plan_id FROM provider_plans WHERE provider = 'razorpay' AND plan_code = $1 AND cycle = $2 AND amount_paise = $3`, [plan, cycle, amountPaise]);
    return kept.provider_plan_id;
  }
  const planByProviderId = async (id) => (id ? (await platformDb.query(`SELECT plan_code, cycle, amount_paise FROM provider_plans WHERE provider = 'razorpay' AND provider_plan_id = $1`, [id]))[0] ?? null : null);

  // ---- telling the owner ----

  /**
   * Tells the owner through ctx.notify inside the transaction. Until billing's kinds are rows of NOTIFY_EVENTS (the contract
   * keeps 'billing.' reserved), notify refuses them before writing anything; the owner then gets an owner alert in the same
   * transaction instead, which the in-app list shows. Data is ids and numbers only; the words are Bhava's.
   */
  async function tell(t, { kind, key, data = {}, message }) {
    try {
      if (!ctx.notify?.emit) throw new Error('not a notification kind: no notify');
      await ctx.notify.emit({ event: kind, tenantId: tenantId(), audience: 'owner', key, data, link: '/billing' }, t);
      return 'notify';
    } catch (err) {
      if (!/kept for a later phase|not a notification kind/.test(String(err?.message))) throw err;
      await alertsRepo(t).raise({ kind, message, severity: 'critical', target: 'billing', dedupeKey: key });
      return 'alert';
    }
  }

  // ---- the plan follows what is paid ----

  /**
   * Moves tenants.plan to what the subscription says, through one plan_changes row (the trigger moves the plan). Runs after
   * the transaction that changed the subscription, on the platform handle, and re-reads both rows under their locks, so of
   * two changes made at once the plan always ends as the subscription's last word. A subscription that was never paid moves
   * nothing. A cancelled one runs to the end of the period already paid for (user decision 2026-11-26, F-51), then moves the
   * business to Free: until then it changes nothing, and fallBackEnded() (the renewals job) moves it once the period ends.
   */
  async function syncPlan(business, { actor = 'billing', source = 'billing', reason = '' } = {}) {
    return platformDb.tx(async (p) => {
      const [s] = await p.query('SELECT plan, cycle, status, current_period_end FROM subscriptions WHERE tenant_id = $1 FOR UPDATE', [business]);
      if (!s) return null;
      const [t] = await p.query('SELECT plan, billing_cycle FROM tenants WHERE id = $1 FOR UPDATE', [business]);
      const paidAhead = Boolean(s.current_period_end) && new Date(s.current_period_end) > at();
      const want = s.status === 'cancelled' ? (paidAhead ? null : { plan: 'free', cycle: t.billing_cycle }) : s.current_period_end ? { plan: s.plan, cycle: s.cycle } : null;
      if (!want || (t.plan === want.plan && t.billing_cycle === want.cycle)) return null;
      await p.query(
        `INSERT INTO plan_changes (tenant_id, from_plan, to_plan, from_cycle, to_cycle, actor, source, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [business, t.plan, want.plan, t.billing_cycle, want.cycle, actor, source, reason.slice(0, 500)],
      );
      return want;
    });
  }

  /**
   * Moves tenants.status to what the subscription says (PRD 5.1, 5.12; R3-MONEY-1): a suspended subscription suspends the
   * business, and when it is no longer suspended the business gets back the status it had. Only a suspension billing made
   * is lifted (billing_suspended_from marks it). Runs after the transaction that changed the subscription, on the platform
   * handle (the app login cannot write tenants.status), re-reading both rows under their locks, so it always ends at the
   * subscription's last word; graceSweep() runs it for any business whose two rows disagree.
   */
  async function syncStatus(business) {
    return platformDb.tx(async (p) => {
      const [s] = await p.query('SELECT status FROM subscriptions WHERE tenant_id = $1 FOR UPDATE', [business]);
      await p.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [business]);
      if (s?.status === 'suspended') {
        return (await p.query(
          `UPDATE tenants SET status = 'suspended', billing_suspended_from = status WHERE id = $1 AND status IN ('onboarding', 'active', 'paused') RETURNING id`,
          [business],
        )).length > 0;
      }
      return (await p.query(
        `UPDATE tenants SET status = billing_suspended_from, billing_suspended_from = NULL WHERE id = $1 AND status = 'suspended' AND billing_suspended_from IS NOT NULL RETURNING id`,
        [business],
      )).length > 0;
    });
  }

  // ---- the owner-locked pause ----

  /** The billing hold on sends: an owner-locked pause (4.12). A pause support set stays support's. */
  async function holdSends(t) {
    await t.query(
      `UPDATE compliance_settings SET paused = true, paused_by = CASE WHEN paused AND paused_by = 'ops' THEN 'ops' ELSE 'billing' END,
         paused_at = COALESCE(paused_at, now()), pause_reason = CASE WHEN paused AND paused_by = 'ops' THEN pause_reason ELSE 'Billing: payment overdue' END, updated_at = now()
       WHERE tenant_id = $1`,
      [tenantId()],
    );
  }
  /** Lifts billing's hold only: an owner's or support's own pause stays. */
  async function releaseSends(t) {
    const rows = await t.query(
      `UPDATE compliance_settings SET paused = false, paused_by = NULL, paused_at = NULL, pause_reason = '', pause_store = false, updated_at = now()
       WHERE tenant_id = $1 AND paused AND paused_by = 'billing' RETURNING tenant_id`,
      [tenantId()],
    );
    return rows.length > 0;
  }
  /** The compliance row exists before a transaction touches it (repos.compliance.settings makes it, with its salt). */
  const ensureCompliance = async () => {
    await ctx.repos.compliance?.settings?.();
  };
  const switchesChanged = async () => {
    try {
      ctx.compliance?.invalidateSwitches?.();
      await ctx.compliance?.poke?.();
    } catch (err) {
      reportError(err, { msg: 'billing.switches_failed' });
    }
  };

  // ---- issuing documents ----

  /**
   * Writes one document and all its lines in the caller's transaction. The database numbers it (one series per type and
   * financial year, no gaps), refuses a second document for the same source_ref before taking a number, checks at commit
   * that the totals are the sum of the lines, and never lets it change again.
   */
  async function issue(t, { docType = 'invoice', sourceRef, lines, settings, buyer, placeOfSupply, periodStart = null, periodEnd = null, originalInvoiceId = null, reason = '', issuedAt = null }) {
    if (!lines.length) throw new Error('A document needs at least one line');
    const totals = totalsOf(lines);
    const [doc] = await t.query(
      `INSERT INTO bhava_invoices (tenant_id, doc_type, fy, seq, number, issued_at, source_ref, period_start, period_end, original_invoice_id, reason, seller, buyer, place_of_supply,
         taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
       VALUES ($1, $2, 0, 0, '', COALESCE($3::timestamptz, now()), $4, $5::date, $6::date, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [tenantId(), docType, issuedAt ? iso(issuedAt) : null, sourceRef, periodStart, periodEnd, originalInvoiceId, reason.slice(0, 500), JSON.stringify(sellerOf(settings)), JSON.stringify(buyer), placeOfSupply,
        totals.taxablePaise, totals.cgstPaise, totals.sgstPaise, totals.igstPaise, totals.totalPaise],
    );
    let position = 0;
    for (const line of lines) {
      await t.query(
        `INSERT INTO bhava_invoice_lines (tenant_id, invoice_id, position, kind, code, description, sac, quantity, unit_paise, gross_paise, discount_paise, taxable_paise, rate_bp,
           cgst_paise, sgst_paise, igst_paise, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date, $18::date)`,
        [tenantId(), doc.id, line.position ?? ++position, line.kind, line.code, line.description, line.sac ?? '', line.quantity, line.unitPaise, line.grossPaise, line.discountPaise,
          line.taxablePaise, line.rateBp, line.cgstPaise, line.sgstPaise, line.igstPaise, line.periodStart ?? null, line.periodEnd ?? null],
      );
    }
    return doc;
  }

  // ---- views ----

  const addonsByCode = async (q) => new Map((await q.query('SELECT * FROM addons')).map((a) => [a.code, a]));
  const toItem = (row, addons) => ({
    id: Number(row.id), code: row.addon_code, name: addons.get(row.addon_code)?.name ?? row.addon_code, kind: row.kind, cycle: row.cycle, quantity: Number(row.quantity),
    unitPricePaise: Number(row.unit_price_paise), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at),
  });
  const runningItems = (q) => q.query('SELECT * FROM subscription_items WHERE tenant_id = $1 AND (ends_at IS NULL OR ends_at > now()) ORDER BY id', [tenantId()]);

  /** What the business is on, as billing.plan answers it. */
  async function plan(q = db) {
    const t = await tenantOf(q);
    const s = await subOf(q);
    const info = await planOf(q, t.plan);
    const addons = await addonsByCode(q);
    const items = await runningItems(q);
    const offer = asOffer(await offerRow(q, s?.offer_code));
    const [paid] = await q.query(`SELECT 1 FROM billing_payments WHERE tenant_id = $1 AND status = 'captured' LIMIT 1`, [tenantId()]);
    const pending = s && s.status !== 'cancelled' && !s.current_period_end && s.plan !== t.plan;
    let next = 0;
    if (s && s.status !== 'cancelled') {
      const nextPlan = s.next_plan ?? s.plan;
      const nextCycle = s.next_cycle ?? s.cycle;
      if (nextPlan !== 'free') {
        const price = await priceOf(q, nextPlan, nextCycle);
        const gross = Number(price?.amount_paise ?? 0);
        next += gross - discountFor(gross, offer);
        for (const item of items) {
          const due = item.cycle === 'monthly' ? !item.ends_at || (s.current_period_end && new Date(item.ends_at) > new Date(s.current_period_end)) : item.billed_through === null;
          if (!due) continue;
          const gross2 = Number(item.unit_price_paise) * Number(item.quantity) * (item.cycle === 'monthly' ? monthsOf(nextCycle) : 1);
          next += gross2 - (offer?.appliesTo === 'plan_and_addons' ? discountFor(gross2, offer) : 0);
        }
      }
    }
    return {
      plan: t.plan, planName: info?.name ?? t.plan, cycle: t.billing_cycle, status: s?.status ?? 'active', nextChargePaise: next,
      periodEnd: iso(s?.current_period_end), graceUntil: iso(s?.grace_until),
      nextPlan: s?.next_plan ?? (pending ? s.plan : null), nextCycle: s?.next_cycle ?? (pending && s.cycle !== t.billing_cycle ? s.cycle : null),
      offer: offer && { code: offer.code, name: offer.name, percentOff: offer.percentOff, forLife: offer.forLife },
      hasPaymentMethod: Boolean(paid), items: items.map((row) => toItem(row, addons)),
    };
  }

  /** Why this business may not buy an add-on now, or null. */
  async function unavailable(q, addon, { tenant, settings, items }) {
    const rank = planRank(tenant.plan);
    if (addon.included_from && rank >= planRank(addon.included_from)) return 'included';
    if (rank < planRank(addon.min_plan)) return 'needs_plan';
    if (addon.kind === 'pack' && tenant.plan === 'free' && !settings.free_can_buy_packs) return 'needs_plan';
    if (!addon.many && items.some((i) => i.addon_code === addon.code)) return 'already_has';
    return null;
  }

  /** The offer a first payment would take now: the one this business already holds, else the launch offer while places last. */
  async function offerOpen(q) {
    const [held] = await q.query('SELECT o.* FROM offer_claims c JOIN offers o ON o.code = c.offer_code WHERE c.tenant_id = $1 ORDER BY c.claimed_at LIMIT 1', [tenantId()]);
    if (held) return held;
    const [launch] = await q.query(`SELECT * FROM offers WHERE code = 'launch' AND active AND claimed < max_accounts`);
    return launch ?? null;
  }

  async function catalog(q = db) {
    const tenant = await tenantOf(q);
    const settings = await settingsOf(q);
    const plans = await q.query(
      `SELECT p.code, p.name, p.rank, m.amount_paise AS monthly, y.amount_paise AS yearly, f.limit_value AS dms, (f.plan_code IS NOT NULL) AS has_dms
       FROM plans p JOIN plan_prices m ON m.plan_code = p.code AND m.cycle = 'monthly' JOIN plan_prices y ON y.plan_code = p.code AND y.cycle = 'yearly'
       LEFT JOIN plan_features f ON f.plan_code = p.code AND f.feature = 'dms.monthly' ORDER BY p.rank`,
    );
    const items = await runningItems(q);
    const addons = await q.query('SELECT * FROM addons WHERE active ORDER BY position, code');
    const out = [];
    for (const a of addons) {
      const why = await unavailable(q, a, { tenant, settings, items });
      out.push({
        code: a.code, name: a.name, kind: a.kind, pricePaise: Number(a.price_paise), cycle: a.cycle, feature: a.feature, minPlan: a.min_plan, includedFrom: a.included_from,
        meter: a.meter, units: n(a.units), many: Boolean(a.many), available: !why, unavailable: why,
      });
    }
    const offer = asOffer(await offerOpen(q));
    return {
      plans: plans.map((p) => ({ code: p.code, name: p.name, rank: Number(p.rank), monthlyPaise: Number(p.monthly), yearlyPaise: Number(p.yearly), includedDms: p.has_dms ? n(p.dms) : 0, current: p.code === tenant.plan })),
      addons: out, taxRateBp: Number(settings.tax_rate_bp), offer: offer && { code: offer.code, name: offer.name, percentOff: offer.percentOff, forLife: offer.forLife },
    };
  }

  // ---- changing the plan ----

  const needSettings = (settings) => {
    if (!complete(settings)) throw new ApiError('conflict', 'Paid plans aren’t open yet. Please try again later.', { reason: 'billing_not_ready' });
  };

  async function change({ plan: target, cycle: wanted }, user) {
    if (!(await planOf(db, target))) throw new ApiError('validation_failed', 'Choose a plan.', { fields: { plan: 'Choose a plan' } });
    const settings = await settingsOf(db);
    const before = await subOf(db);
    const tenant = await tenantOf(db);
    const cycle = target === 'free' ? tenant.billing_cycle : wanted ?? before?.next_cycle ?? before?.cycle ?? tenant.billing_cycle ?? 'monthly';
    const actor = `user:${user.id}`;

    // The provider's plans for both prices this change could need, made before the lock: with the offer and without.
    const ids = {};
    let placeOfSupply = '';
    if (target !== 'free') {
      needSettings(settings);
      const buyer = await buyerOf(db, settings);
      placeOfSupply = buyer.stateCode;
      const offers = [null, asOffer(before?.offer_code ? await offerRow(db, before.offer_code) : await offerOpen(db))].filter((o, i) => i === 0 || o);
      for (const offer of offers) {
        const line = await planLine(db, { plan: target, cycle, offer, settings, placeOfSupply });
        ids[offer?.code ?? ''] = await providerPlan({ plan: target, cycle, amountPaise: line.totalPaise, name: line.description }).catch((err) => { throw providerFailure(err); });
      }
    }

    let result;
    try {
      result = await locked(async (t) => {
        const tNow = await tenantOf(t);
        const s = await subOf(t, { forUpdate: true });
        const audit = (effective) => writeAudit(t, { actor, action: 'billing.change', target: 'plan', details: { from: tNow.plan, to: target, cycle, effective } });
        const live = s && s.provider_subscription_id && s.status !== 'cancelled';

        if (target === 'free') {
          if (!live) {
            await audit('now');
            return { effective: 'now', checkoutUrl: null, toFree: tNow.plan !== 'free' };
          }
          if (s.status === 'suspended') throw new ApiError('conflict', 'Pay what is due first, then change your plan.', { reason: 'suspended' });
          if (!s.current_period_end) {
            await provider().cancel(s.provider_subscription_id, { atCycleEnd: false });
            await t.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), next_plan = NULL, next_cycle = NULL, updated_at = now() WHERE id = $1`, [s.id]);
            await audit('now');
            return { effective: 'now', checkoutUrl: null };
          }
          if (s.next_plan !== 'free') {
            await provider().cancel(s.provider_subscription_id, { atCycleEnd: true });
            await t.query(`UPDATE subscriptions SET next_plan = 'free', next_cycle = NULL, updated_at = now() WHERE id = $1`, [s.id]);
          }
          await audit('period_end');
          return { effective: 'period_end', checkoutUrl: null };
        }

        const offerCode = live ? s.offer_code : null;
        if (!live) {
          // A first paying subscription (or one after a cancelled one): the offer is claimed here, under the offer row's lock,
          // and comes back if anything below fails, because the claim is part of this transaction.
          const open = await offerOpen(t);
          let claimed = null;
          if (open && ids[open.code]) {
            const [{ ok }] = await t.query('SELECT claim_offer($1) AS ok', [open.code]);
            if (ok) claimed = open.code;
          }
          // The old subscription Bhava ended must be ended at the provider first, or both would charge (M-6).
          if (s?.provider_cancel_pending && !(await settleProviderCancel(t))) {
            throw new ApiError('conflict', 'Your previous Bhava subscription is still being closed. Please try again in a few minutes.', { reason: 'provider' });
          }
          const planId = ids[claimed ?? ''];
          const [owner] = await t.query(`SELECT name, phone, email FROM users WHERE tenant_id = $1 AND role = 'owner' ORDER BY id LIMIT 1`, [tenantId()]);
          const customerId = s?.provider_customer_id ?? (await provider().createCustomer({ name: tNow.legal_name || tNow.name, email: owner?.email ?? '', phone: owner?.phone ?? '', reference: `tenant:${tenantId()}` })).id;
          const made = await provider().createSubscription({ customerId, planId, notes: { tenant: String(tenantId()) } });
          if (s) {
            await t.query(
              `UPDATE subscriptions SET plan = $2, cycle = $3, status = 'active', provider_customer_id = $4, provider_subscription_id = $5, current_period_start = NULL, current_period_end = NULL,
                 grace_until = NULL, offer_code = $6, next_plan = NULL, next_cycle = NULL, suspended_at = NULL, cancelled_at = NULL, updated_at = now() WHERE id = $1`,
              [s.id, target, cycle, customerId, made.id, claimed],
            );
          } else {
            await t.query(
              `INSERT INTO subscriptions (tenant_id, plan, cycle, status, provider_customer_id, provider_subscription_id, offer_code) VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
              [tenantId(), target, cycle, customerId, made.id, claimed],
            );
          }
          await audit('now');
          return { effective: 'now', checkoutUrl: made.hostedUrl ?? null };
        }

        const planId = ids[offerCode ?? ''];
        if (!planId) throw new ApiError('conflict', 'Prices just changed. Please try again.', { reason: 'retry' });
        if (s.status === 'suspended') throw new ApiError('conflict', 'Pay what is due first, then change your plan.', { reason: 'suspended' });
        if (!s.current_period_end) {
          // Not paid yet: the subscription waiting for its first payment is changed in place.
          const changed = await provider().changeSubscription(s.provider_subscription_id, { planId, at: 'now' });
          await t.query('UPDATE subscriptions SET plan = $2, cycle = $3, next_plan = NULL, next_cycle = NULL, updated_at = now() WHERE id = $1', [s.id, target, cycle]);
          await audit('now');
          return { effective: 'now', checkoutUrl: changed.hostedUrl ?? null };
        }
        if (s.plan === target && s.cycle === cycle) {
          if (s.next_plan === 'free') throw new ApiError('conflict', 'Your plan ends when this period does. Pick a plan again after that.', { reason: 'ending' });
          if (s.next_plan) {
            await provider().changeSubscription(s.provider_subscription_id, { planId, at: 'cycle_end' });
            await t.query('UPDATE subscriptions SET next_plan = NULL, next_cycle = NULL, updated_at = now() WHERE id = $1', [s.id]);
            await audit('now');
          }
          return { effective: 'now', checkoutUrl: null };
        }
        if (s.next_plan === 'free') throw new ApiError('conflict', 'Your plan ends when this period does. Pick a plan again after that.', { reason: 'ending' });
        if (s.next_plan === target && (s.next_cycle ?? s.cycle) === cycle) return { effective: 'period_end', checkoutUrl: null };
        if (planRank(target) > planRank(s.plan)) {
          await provider().changeSubscription(s.provider_subscription_id, { planId, at: 'now' });
          await t.query('UPDATE subscriptions SET plan = $2, cycle = $3, next_plan = NULL, next_cycle = NULL, updated_at = now() WHERE id = $1', [s.id, target, cycle]);
          await audit('now');
          return { effective: 'now', checkoutUrl: null };
        }
        await provider().changeSubscription(s.provider_subscription_id, { planId, at: 'cycle_end' });
        await t.query('UPDATE subscriptions SET next_plan = $2, next_cycle = $3, updated_at = now() WHERE id = $1', [s.id, target, cycle]);
        await audit('period_end');
        return { effective: 'period_end', checkoutUrl: null };
      });
    } catch (err) {
      throw providerFailure(err);
    }

    if (target === 'free' && result.effective === 'period_end') await endUnpaid(actor);
    if (target === 'free' && result.effective === 'now') await endWithSubscription(actor);
    if (result.toFree) {
      // No subscription to end (a plan set by the console): the owner's own move to Free is recorded as theirs.
      await platformDb.query(
        `INSERT INTO plan_changes (tenant_id, from_plan, to_plan, from_cycle, to_cycle, actor, source, reason) SELECT id, plan, 'free', billing_cycle, billing_cycle, $2, 'owner', '' FROM tenants WHERE id = $1 AND plan <> 'free'`,
        [tenantId(), actor],
      );
    } else {
      await syncPlan(tenantId(), { actor, source: 'owner' });
    }
    return { plan: await plan(), effective: result.effective, checkoutUrl: result.checkoutUrl };
  }

  // ---- add-ons, packs, services, setup ----

  /** The feature an add-on switches on, as this business's override; an extra seat raises a counted limit. */
  async function switchOn(t, addon, tenant) {
    if (!addon.feature) return;
    if (addon.feature === 'staff.seats') {
      const [base] = await t.query(`SELECT limit_value FROM plan_features WHERE plan_code = $1 AND feature = 'staff.seats'`, [tenant.plan]);
      if (!base || base.limit_value === null) return; // no limit on this plan: a seat changes nothing yet
      const [{ seats }] = await t.query(`SELECT COALESCE(sum(quantity), 0)::int AS seats FROM subscription_items WHERE tenant_id = $1 AND addon_code = $2 AND (ends_at IS NULL OR ends_at > now())`, [tenantId(), addon.code]);
      await t.query(
        `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'staff.seats', true, $2) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = true, limit_value = EXCLUDED.limit_value`,
        [tenantId(), Number(base.limit_value) + Number(seats)],
      );
      return;
    }
    await t.query(`INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, $2, true, NULL) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = true`, [tenantId(), addon.feature]);
  }

  /** Takes an add-on's feature away once nothing that brings it runs any more. */
  async function switchOffEnded(t) {
    const ended = await t.query(
      `SELECT DISTINCT a.feature FROM subscription_items i JOIN addons a ON a.code = i.addon_code
       WHERE i.tenant_id = $1 AND a.feature IS NOT NULL AND a.feature <> 'staff.seats' AND i.ends_at IS NOT NULL AND i.ends_at <= now()
         AND NOT EXISTS (SELECT 1 FROM subscription_items j JOIN addons b ON b.code = j.addon_code WHERE j.tenant_id = i.tenant_id AND b.feature = a.feature AND (j.ends_at IS NULL OR j.ends_at > now()))`,
      [tenantId()],
    );
    for (const { feature } of ended) await t.query('DELETE FROM tenant_features WHERE tenant_id = $1 AND feature = $2 AND enabled', [tenantId(), feature]);
    return ended.length;
  }

  /**
   * Queues one line with the provider for the next charge, under the business's billing lock (atk-money-1). The provider
   * cannot make "find the line by its key, else add it" one step (Razorpay add-ons take no idempotency header), so two
   * callers at once would each add a line. Under the lock the line is read again: one another caller queued, a charge
   * billed, or a removal ended since the caller read it is left alone. The same key always answers the same line, so a
   * retry after a lost answer never doubles it.
   * `since` is the earliest the provider can have made a line with this key (money-6): the item's creation for its first
   * charge, the start of the queueing window for a renewal. The provider's repeat check looks no further back.
   */
  async function queueItem(item, key, { settings, months, since = item.created_at }) {
    return locked(async (t) => {
      const s = await subOf(t);
      if (!s?.provider_subscription_id || s.status === 'cancelled') return null;
      // Still waiting to be queued, as the caller saw it; a line removed in the meantime is never queued (money-4). The caller
      // saw billed_through through the driver, which keeps milliseconds and drops the microseconds Postgres stores, so the
      // check is made at that resolution: an exact match on a value set by SQL (now(), a period copied from the provider's
      // row) would never hold, and the line would never be charged again.
      const [now] = await t.query(
        `SELECT * FROM subscription_items WHERE tenant_id = $1 AND id = $2 AND provider_item_id IS NULL AND date_trunc('milliseconds', billed_through) IS NOT DISTINCT FROM $3::timestamptz
           AND (ends_at IS NULL OR ends_at > now())`,
        [tenantId(), item.id, iso(item.billed_through)],
      );
      if (!now) return null;
      const addons = await addonsByCode(t);
      const offer = asOffer(await offerRow(t, s.offer_code));
      const buyer = await buyerOf(t, settings);
      const line = itemLine(now, addons.get(now.addon_code), { offer, settings, placeOfSupply: buyer.stateCode, months });
      if (line.totalPaise <= 0) {
        await t.query('UPDATE subscription_items SET provider_item_id = $3 WHERE tenant_id = $1 AND id = $2 AND provider_item_id IS NULL', [tenantId(), now.id, `free:${now.id}`]);
        return null;
      }
      const added = await provider().addCharge(s.provider_subscription_id, { name: line.description, amountPaise: line.totalPaise, quantity: 1, idempotencyKey: key, since });
      await t.query('UPDATE subscription_items SET provider_item_id = $3 WHERE tenant_id = $1 AND id = $2 AND provider_item_id IS NULL', [tenantId(), now.id, added.id]);
      return added.id;
    });
  }

  /**
   * A removed or never-paid line's charge still waiting at the provider is taken back (money-4, money-10): by its id, or by
   * its first key when that answer was lost. Done, the line is marked `free:<id>` (nothing to charge), so nothing queues or
   * invoices it again. A provider that already charged it refuses; the charge's invoice then carries it (applyCharge). A
   * failure is left for the renewals job, which tries again. -> true once nothing is pending
   */
  async function dropPending(item, s) {
    const pid = item.provider_item_id;
    if (pid?.startsWith('free:')) return true;
    if (!pid && item.billed_through) return true; // charged already, and nothing queued since
    if (s?.provider_subscription_id) {
      try {
        await provider().removeCharge(s.provider_subscription_id, pid ? { addonId: pid } : { idempotencyKey: `item:${item.id}:first`, since: item.created_at });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        log.warn('billing.drop_deferred', { item: Number(item.id), kind: err.kind, delivery: err.delivery });
        return false;
      }
    }
    await db.query('UPDATE subscription_items SET provider_item_id = $3 WHERE tenant_id = $1 AND id = $2 AND provider_item_id IS NOT DISTINCT FROM $4', [tenantId(), item.id, `free:${item.id}`, pid ?? null]);
    return true;
  }

  /** Lines that ended with a charge still pending at the provider: removed ones, and never-paid ones of an ending subscription. */
  const pendingEnded = (q) => q.query(
    `SELECT * FROM subscription_items WHERE tenant_id = $1 AND ends_at IS NOT NULL
       AND ((provider_item_id IS NOT NULL AND provider_item_id NOT LIKE 'free:%') OR (provider_item_id IS NULL AND billed_through IS NULL)) ORDER BY id`,
    [tenantId()],
  );

  async function addItem({ code, quantity = 1, requestKey }, user) {
    const settings = await settingsOf(db);
    const [addon] = await db.query('SELECT * FROM addons WHERE code = $1 AND active', [code]);
    if (!addon) throw new ApiError('validation_failed', 'Choose an add-on.', { fields: { code: 'Choose an add-on' } });
    if (!addon.many && quantity !== 1) throw new ApiError('validation_failed', 'You can have one of these.', { fields: { quantity: 'Only one' } });
    needSettings(settings);
    let created;
    try {
      created = await locked(async (t) => {
        const [again] = await t.query('SELECT * FROM subscription_items WHERE tenant_id = $1 AND request_key = $2', [tenantId(), requestKey]);
        if (again) {
          if (again.addon_code !== addon.code || Number(again.quantity) !== quantity) throw new ApiError('conflict', 'That request was already used for something else.', { reason: 'request_key' });
          return { row: again, fresh: false };
        }
        const tenant = await tenantOf(t);
        const s = await subOf(t, { forUpdate: true });
        const items = await runningItems(t);
        const why = await unavailable(t, addon, { tenant, settings, items });
        if (why === 'needs_plan') throw planOff(addon.feature ?? addon.code, { reason: 'needs_plan', plan: addon.min_plan });
        if (why === 'included') throw new ApiError('conflict', 'Your plan already includes this.', { reason: 'included' });
        if (why === 'already_has') throw new ApiError('conflict', 'You already have this.', { reason: 'already_has' });
        if (!s?.provider_subscription_id || s.status === 'cancelled') throw new ApiError('conflict', 'Pick a paid plan first.', { reason: 'needs_subscription' });
        if (s.status === 'suspended') throw new ApiError('conflict', 'Pay what is due first.', { reason: 'suspended' });
        // Granted at once but charged with the next subscription charge, so only on a paid subscription that has one coming (money-10).
        if (!s.current_period_end) throw new ApiError('conflict', 'Finish paying for your plan first.', { reason: 'needs_subscription' });
        if (s.next_plan === 'free') throw new ApiError('conflict', 'Your plan ends when this period does, so nothing more can be added.', { reason: 'ending' });
        const [row] = await t.query(
          `INSERT INTO subscription_items (tenant_id, subscription_id, addon_code, kind, quantity, unit_price_paise, cycle, created_by, request_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [tenantId(), s.id, addon.code, addon.kind, quantity, addon.price_paise, addon.cycle, `user:${user.id}`, requestKey],
        );
        await switchOn(t, addon, tenant);
        await writeAudit(t, { actor: `user:${user.id}`, action: 'billing.item_added', target: `item:${row.id}`, details: { code: addon.code, quantity } });
        return { row, fresh: true, cycle: s.cycle };
      });
    } catch (err) {
      throw providerFailure(err);
    }
    if (created.fresh || !created.row.provider_item_id) {
      try {
        await queueItem(created.row, `item:${created.row.id}:first`, { settings, months: monthsOf(created.cycle ?? 'monthly') });
      } catch (err) {
        // The line is retried by the renewals job with the same key; the purchase stands.
        if (!(err instanceof ProviderError)) throw err;
        log.warn('billing.queue_deferred', { item: Number(created.row.id), kind: err.kind, delivery: err.delivery });
      }
      if (addon.kind === 'pack') await Promise.resolve(ctx.compliance?.releaseDmLimit?.()).catch((err) => reportError(err, { msg: 'billing.release_dm_limit' }));
    }
    const addons = await addonsByCode(db);
    const [row] = await db.query('SELECT * FROM subscription_items WHERE tenant_id = $1 AND id = $2', [tenantId(), created.row.id]);
    return { item: toItem(row, addons), checkoutUrl: null };
  }

  async function removeItem(id, user) {
    let removed = null;
    const done = await locked(async (t) => {
      const [item] = await t.query('SELECT * FROM subscription_items WHERE tenant_id = $1 AND id = $2 AND (ends_at IS NULL OR ends_at > now()) FOR UPDATE', [tenantId(), id]);
      if (!item) return null;
      if (item.cycle === 'one_time') throw new ApiError('conflict', 'A one-time purchase can’t be removed. Ask us if something went wrong.', { reason: 'one_time' });
      const s = await subOf(t);
      // A paid period runs to its end; with nothing paid yet it ends now.
      const end = s?.current_period_end && new Date(s.current_period_end) > at() && item.billed_through ? s.current_period_end : null;
      await t.query('UPDATE subscription_items SET ends_at = GREATEST(starts_at, COALESCE($3::timestamptz, now())) WHERE tenant_id = $1 AND id = $2', [tenantId(), id, end ? iso(end) : null]);
      await switchOffEnded(t);
      await writeAudit(t, { actor: `user:${user.id}`, action: 'billing.item_removed', target: `item:${id}`, details: { code: item.addon_code } });
      removed = { item, s };
      return true;
    });
    if (!done) throw new ApiError('not_found');
    // Whatever is waiting at the provider for this line is taken back: removed is never charged again (money-4).
    const [now] = await db.query('SELECT * FROM subscription_items WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
    if (now) await dropPending(now, removed.s);
  }

  /**
   * The business scheduled its move to Free: the provider will charge nothing more, so every line not yet paid for ends now
   * and its pending provider charge is taken back (money-10). Paid lines run to the end of what is paid.
   */
  async function endUnpaid(actor) {
    const ended = await locked(async (t) => {
      const rows = await t.query(
        `UPDATE subscription_items SET ends_at = GREATEST(starts_at, now()) WHERE tenant_id = $1 AND billed_through IS NULL AND (ends_at IS NULL OR ends_at > now()) RETURNING *`,
        [tenantId()],
      );
      if (rows.length) {
        await switchOffEnded(t);
        await writeAudit(t, { actor, action: 'billing.items_ended', target: 'plan', details: { items: rows.map((r) => Number(r.id)), reason: 'moving_to_free_unpaid' } });
      }
      return rows;
    });
    const s = await subOf(db);
    for (const item of ended) await dropPending(item, s);
    return ended.length;
  }

  /**
   * A cancelled subscription charges nothing more, so the lines it charged end with it (money-10): a recurring line runs to
   * the end of the period already paid for (when still ahead) and a line never paid for ends now, its charge still waiting
   * at the provider taken back. A one-time purchase already paid for stays. Features of lines that have ended are switched
   * off. Called where a subscription is cancelled, and by renewals for cancelled ones, so a paid period that ends later is
   * switched off then. Does nothing while the subscription is not cancelled. -> how many lines it ended
   */
  async function endWithSubscription(actor = 'billing') {
    const ended = await locked(async (t) => {
      const s = await subOf(t, { forUpdate: true });
      if (!s || s.status !== 'cancelled') return null;
      const paidUntil = s.current_period_end && new Date(s.current_period_end) > at() ? iso(s.current_period_end) : null;
      const rows = await t.query(
        `UPDATE subscription_items SET ends_at = GREATEST(starts_at, CASE WHEN billed_through IS NOT NULL AND $2::timestamptz IS NOT NULL THEN $2::timestamptz ELSE now() END)
         WHERE tenant_id = $1 AND ends_at IS NULL AND NOT (cycle = 'one_time' AND billed_through IS NOT NULL) RETURNING *`,
        [tenantId(), paidUntil],
      );
      await switchOffEnded(t);
      if (rows.length) await writeAudit(t, { actor, action: 'billing.items_ended', target: 'plan', details: { items: rows.map((r) => Number(r.id)), reason: 'subscription_cancelled' } });
      return { s, rows };
    });
    if (!ended) return 0;
    for (const item of ended.rows) if (!item.billed_through) await dropPending(item, ended.s);
    return ended.rows.length;
  }

  // ---- invoices ----

  const toLine = (l) => ({
    kind: l.kind, code: l.code, description: l.description, quantity: Number(l.quantity), unitPaise: Number(l.unit_paise), grossPaise: Number(l.gross_paise), discountPaise: Number(l.discount_paise),
    taxablePaise: Number(l.taxable_paise), rateBp: Number(l.rate_bp), cgstPaise: Number(l.cgst_paise), sgstPaise: Number(l.sgst_paise), igstPaise: Number(l.igst_paise),
  });
  async function toInvoices(q, rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const lines = await q.query('SELECT * FROM bhava_invoice_lines WHERE tenant_id = $1 AND invoice_id = ANY($2::bigint[]) ORDER BY invoice_id, position', [tenantId(), ids]);
    const paid = new Set((await q.query(`SELECT invoice_id FROM billing_payments WHERE tenant_id = $1 AND status = 'captured' AND invoice_id = ANY($2::bigint[])`, [tenantId(), ids])).map((r) => Number(r.invoice_id)));
    return rows.map((r) => ({
      id: Number(r.id), docType: r.doc_type, number: r.number, issuedAt: iso(r.issued_at), periodStart: day(r.period_start), periodEnd: day(r.period_end),
      originalInvoiceId: n(r.original_invoice_id), taxablePaise: Number(r.taxable_paise), cgstPaise: Number(r.cgst_paise), sgstPaise: Number(r.sgst_paise), igstPaise: Number(r.igst_paise),
      totalPaise: Number(r.total_paise), paid: paid.has(Number(r.id)), hasFile: Boolean(r.file_key), lines: lines.filter((l) => Number(l.invoice_id) === Number(r.id)).map(toLine),
    }));
  }
  const readCursor = (cursor) => {
    if (!cursor) return null;
    const value = Buffer.from(cursor, 'base64url').toString();
    if (!/^\d{1,18}$/.test(value)) throw new ApiError('validation_failed', 'That page link has expired. Go back to the first page.', { fields: { cursor: 'Invalid cursor' } });
    return value;
  };
  const invoices = {
    async list({ cursor, limit = 25 } = {}, q = db) {
      const rows = await q.query('SELECT * FROM bhava_invoices WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3', [tenantId(), readCursor(cursor), limit + 1]);
      const shown = rows.slice(0, limit);
      return { items: await toInvoices(q, shown), nextCursor: rows.length > limit ? Buffer.from(String(shown.at(-1).id)).toString('base64url') : null };
    },
    async row(id, q = db) {
      return (await q.query('SELECT * FROM bhava_invoices WHERE tenant_id = $1 AND id = $2', [tenantId(), id]))[0] ?? null;
    },
    async get(id, q = db) {
      const row = await invoices.row(id, q);
      return row ? (await toInvoices(q, [row]))[0] : null;
    },
    lines: (id, q = db) => q.query('SELECT * FROM bhava_invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY position', [tenantId(), id]),
  };

  // ---- what the provider's events do (webhooks.js decides which business and which of these) ----

  /** The last time an event changed this business's subscription, from the events already worked (stale events change nothing). */
  async function lastApplied(business) {
    const [row] = await platformDb.query(
      `SELECT max((payload->>'createdAt')::bigint) AS at FROM provider_webhook_events
       WHERE provider = 'razorpay' AND scope = 'billing' AND tenant_id = $1 AND status = 'processed' AND outcome = 'processed'`,
      [business],
    );
    return row?.at === null || row?.at === undefined ? null : Number(row.at) * 1000;
  }
  const stale = (eventAtMs, lastMs) => lastMs !== null && eventAtMs !== null && eventAtMs < lastMs;

  async function recordPayment(t, { s, payment, status, invoiceId = null }) {
    const [row] = await t.query(
      `INSERT INTO billing_payments (tenant_id, provider, provider_payment_id, provider_subscription_id, provider_invoice_id, amount_paise, status, method, failure_code, invoice_id, paid_at)
       VALUES ($1, 'razorpay', $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz) RETURNING id`,
      [tenantId(), payment.id, s.provider_subscription_id, payment.invoiceId ?? null, payment.amountPaise ?? 0, status, payment.method ?? '', payment.errorCode ?? '', invoiceId,
        status === 'captured' ? iso(payment.createdAt ? payment.createdAt * 1000 : at()) : null],
    );
    return row;
  }
  const seenPayment = async (t, id) => Boolean((await t.query(`SELECT 1 FROM billing_payments WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_payment_id = $2`, [tenantId(), id]))[0]);

  /**
   * subscription.charged: one billing_payments row and one invoice per provider payment id (F-51), whatever the order or the
   * number of deliveries. The invoice carries the plan for the period paid, each add-on line queued for it, and the
   * pass-through charges waiting, each with its count. A charge older than the state already applied still records its
   * payment and invoice, and changes no status.
   */
  async function applyCharge({ ev, planInfo, eventAtMs, lastMs }) {
    const business = tenantId();
    const settings = await settingsOf(db);
    if (!complete(settings)) {
      const err = new Error('Bhava’s legal name, state and SAC are not set: no invoice can be issued');
      err.code = 'billing_not_ready';
      throw err;
    }
    const outcome = await locked(async (t) => {
      const s = await subOf(t, { forUpdate: true });
      if (!s) return { outcome: 'unknown_subscription' };
      if (await seenPayment(t, ev.payment.id)) return { outcome: 'duplicate' };
      const buyer = await buyerOf(t, settings);
      const pos = buyer.stateCode || settings.state_code;
      const offer = asOffer(await offerRow(t, s.offer_code));
      const periodStart = ev.subscription?.currentStart ? day(ev.subscription.currentStart * 1000) : null;
      const periodEnd = ev.subscription?.currentEnd ? day(ev.subscription.currentEnd * 1000) : null;
      const months = monthsOf(planInfo?.cycle ?? s.cycle);
      const addons = await addonsByCode(t);
      const lines = [];
      if (planInfo && planInfo.plan_code !== 'free') lines.push(await planLine(t, { plan: planInfo.plan_code, cycle: planInfo.cycle, offer, settings, placeOfSupply: pos, periodStart, periodEnd }));
      const queued = await t.query(`SELECT * FROM subscription_items WHERE tenant_id = $1 AND provider_item_id IS NOT NULL AND provider_item_id NOT LIKE 'free:%' ORDER BY id`, [business]);
      for (const item of queued) lines.push(itemLine(item, addons.get(item.addon_code), { offer, settings, placeOfSupply: pos, months }));
      // Only what queuePassThrough asked the provider to charge, one line per kind and month, as it was asked for.
      const passing = await t.query(
        `SELECT kind, period, array_agg(id ORDER BY id) AS ids, sum(amount_paise)::bigint AS amount, sum(quantity)::bigint AS quantity FROM pass_through_charges
         WHERE tenant_id = $1 AND collected_by = 'invoice' AND invoice_id IS NULL AND queued_at IS NOT NULL AND kind = ANY($2::text[]) GROUP BY kind, period ORDER BY period, kind`,
        [business, Object.keys(INVOICED_PASS_THROUGH)],
      );
      for (const charge of passing) {
        lines.push(taxedLine({
          kind: 'pass_through', code: charge.kind, description: `${INVOICED_PASS_THROUGH[charge.kind].label} at cost, ${String(day(charge.period)).slice(0, 7)}`, sac: settings.sac,
          quantity: Number(charge.quantity), unitPaise: 0, grossPaise: Number(charge.amount), rateBp: settings.tax_rate_bp, sellerState: settings.state_code, placeOfSupply: pos,
        }));
      }
      const expected = totalsOf(lines).totalPaise;
      let invoice = null;
      if (lines.length) {
        invoice = await issue(t, { sourceRef: `charge:${ev.payment.id}`, lines, settings, buyer, placeOfSupply: pos, periodStart, periodEnd });
        if (queued.length) {
          // A removed line keeps its end: if the provider charged it before it could be taken back, ops credits it (below).
          await t.query(
            `UPDATE subscription_items SET provider_item_id = NULL, billed_through = $3::timestamptz
             WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
            [business, queued.map((i) => Number(i.id)), iso(ev.subscription?.currentEnd ? ev.subscription.currentEnd * 1000 : at())],
          );
        }
        if (passing.length) await t.query('UPDATE pass_through_charges SET invoice_id = $3 WHERE tenant_id = $1 AND id = ANY($2::bigint[])', [business, passing.flatMap((c) => c.ids.map(Number)), invoice.id]);
      }
      // The payment method is noted before any plan change of this charge, so a method shared with the referrer blocks the referral before it is credited (F-129).
      await notePaymentMethod(t, { tenantId: business, fingerprint: ev.payment.methodMark });
      await recordPayment(t, { s, payment: ev.payment, status: 'captured', invoiceId: invoice?.id ?? null });

      let resumed = false;
      if (!stale(eventAtMs, lastMs)) {
        const start = ev.subscription?.currentStart ? iso(ev.subscription.currentStart * 1000) : null;
        const end = ev.subscription?.currentEnd ? iso(ev.subscription.currentEnd * 1000) : null;
        // The scheduled change is applied by a charge for exactly that plan and cycle: a monthly retry of the same plan is not it.
        const moves = s.next_plan && s.next_plan !== 'free' && planInfo && planInfo.plan_code === s.next_plan && planInfo.cycle === (s.next_cycle ?? s.cycle);
        await t.query(
          `UPDATE subscriptions SET status = 'active', grace_until = NULL, suspended_at = NULL,
             current_period_start = CASE WHEN $2::timestamptz IS NOT NULL AND (current_period_end IS NULL OR $3::timestamptz >= current_period_end) THEN $2::timestamptz ELSE current_period_start END,
             current_period_end = CASE WHEN $3::timestamptz IS NOT NULL AND (current_period_end IS NULL OR $3::timestamptz >= current_period_end) THEN $3::timestamptz ELSE current_period_end END,
             plan = CASE WHEN $4 THEN next_plan ELSE plan END, cycle = CASE WHEN $4 THEN COALESCE(next_cycle, cycle) ELSE cycle END,
             next_plan = CASE WHEN $4 THEN NULL ELSE next_plan END, next_cycle = CASE WHEN $4 THEN NULL ELSE next_cycle END, updated_at = now()
           WHERE id = $1`,
          [s.id, start, end, Boolean(moves)],
        );
        if (s.status === 'suspended' || s.status === 'grace' || s.status === 'past_due') {
          resumed = await releaseSends(t);
          if (s.status === 'suspended') await tell(t, { kind: 'billing.resumed', key: `billing:resumed:${ev.payment.id}`, data: { subscriptionId: Number(s.id) }, message: 'Your payment went through. Bhava is sending again.' });
        }
      }
      await writeAudit(t, { actor: 'billing', action: 'billing.charged', target: invoice ? `invoice:${invoice.id}` : 'payment', details: { amountPaise: ev.payment.amountPaise ?? 0, invoice: invoice?.number ?? null } });
      const removedCharged = queued.filter((i) => i.ends_at).map((i) => Number(i.id));
      return { outcome: 'processed', resumed, removedCharged, mismatch: expected !== Number(ev.payment.amountPaise ?? 0) ? { expected, got: Number(ev.payment.amountPaise) } : null, invoiceId: invoice?.id ?? null };
    });
    if (outcome.removedCharged?.length) {
      await opsAlert(platformDb, { tenantId: business, kind: 'billing.removed_item_charged', message: `A Bhava charge included ${outcome.removedCharged.length} add-on line(s) the business had removed before it could be taken back (invoice ${outcome.invoiceId}). Issue a credit note.`, target: `invoice:${outcome.invoiceId}`, dedupeKey: `billing-removed:${outcome.invoiceId}` });
    }
    if (outcome.mismatch) {
      log.warn('billing.amount_mismatch', { tenantId: business, invoice: outcome.invoiceId, expected: outcome.mismatch.expected, got: outcome.mismatch.got });
      await opsAlert(platformDb, { tenantId: business, kind: 'billing.amount_mismatch', message: `A Bhava charge of ${outcome.mismatch.got} paise does not match the ${outcome.mismatch.expected} paise its invoice lists (invoice ${outcome.invoiceId}). Check it and issue a credit note if needed.`, target: `invoice:${outcome.invoiceId}`, dedupeKey: `billing-mismatch:${outcome.invoiceId}` });
    }
    if (outcome.outcome === 'processed') {
      await syncPlan(business);
      await syncStatus(business);
    }
    if (outcome.resumed) await switchesChanged();
    return outcome.outcome;
  }

  /** A failed charge, or the provider giving up: grace until grace_until, with the owner told (F-53). */
  async function applyFailure({ ev, eventAtMs, lastMs, halted = false }) {
    const settings = await settingsOf(db);
    return locked(async (t) => {
      const s = await subOf(t, { forUpdate: true });
      if (!s) return 'unknown_subscription';
      if (ev.payment?.id) {
        if (await seenPayment(t, ev.payment.id)) return 'duplicate';
        await recordPayment(t, { s, payment: ev.payment, status: 'failed' });
      }
      if (stale(eventAtMs, lastMs) || s.status === 'cancelled') return 'stale';
      if (s.status === 'suspended') return 'processed';
      if (s.status === 'grace' || s.status === 'past_due') return 'processed'; // grace runs from the first failure, never longer
      const from = eventAtMs ?? +at();
      const until = new Date(from + Number(settings.grace_days) * DAY);
      await t.query(`UPDATE subscriptions SET status = 'grace', grace_until = $2::timestamptz, updated_at = now() WHERE id = $1`, [s.id, iso(until)]);
      await tell(t, {
        kind: 'billing.payment_failed', key: `billing:failed:${s.id}:${+until}`, data: { days: Number(settings.grace_days), subscriptionId: Number(s.id) },
        message: `Your Bhava payment didn’t go through. Update your payment method within ${settings.grace_days} days to keep sending.`,
      });
      await writeAudit(t, { actor: 'billing', action: 'billing.payment_failed', target: `subscription:${s.id}`, details: { graceUntil: iso(until), halted } });
      return 'processed';
    });
  }

  /** subscription.cancelled: the subscription ended. A business not held for money owed keeps its plan to the end of the paid period, then goes to Free (F-51). */
  async function applyCancel({ eventAtMs, lastMs }) {
    const outcome = await locked(async (t) => {
      const s = await subOf(t, { forUpdate: true });
      if (!s) return 'unknown_subscription';
      if (s.status === 'cancelled') return 'duplicate';
      if (stale(eventAtMs, lastMs)) return 'stale';
      if (s.status === 'suspended') {
        await t.query('UPDATE subscriptions SET cancelled_at = COALESCE(cancelled_at, now()), updated_at = now() WHERE id = $1', [s.id]);
        return 'processed';
      }
      await t.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), next_plan = NULL, next_cycle = NULL, grace_until = NULL, updated_at = now() WHERE id = $1`, [s.id]);
      await writeAudit(t, { actor: 'billing', action: 'billing.cancelled', target: `subscription:${s.id}` });
      return 'processed';
    });
    if (outcome === 'processed') {
      await endWithSubscription();
      await syncPlan(tenantId());
    }
    return outcome;
  }

  /** subscription.activated and .updated: the period, when newer than what is kept. */
  async function applyPeriod({ ev, eventAtMs, lastMs }) {
    if (!ev.subscription?.currentEnd) return 'not_handled';
    return locked(async (t) => {
      const s = await subOf(t, { forUpdate: true });
      if (!s) return 'unknown_subscription';
      if (stale(eventAtMs, lastMs)) return 'stale';
      const rows = await t.query(
        `UPDATE subscriptions SET current_period_start = $2::timestamptz, current_period_end = $3::timestamptz, updated_at = now()
         WHERE id = $1 AND current_period_end IS NOT NULL AND $3::timestamptz > current_period_end RETURNING id`,
        [s.id, iso(ev.subscription.currentStart * 1000), iso(ev.subscription.currentEnd * 1000)],
      );
      return rows.length ? 'processed' : 'not_handled';
    });
  }

  /**
   * Ends at the provider the subscription this business's row says Bhava already ended (provider_cancel_pending, M-6). A
   * cancel that fails is left owed, unless the provider shows that subscription ended anyway. -> true when nothing is owed
   */
  async function settleProviderCancel(q = db) {
    const [s] = await q.query('SELECT id, provider_cancel_pending FROM subscriptions WHERE tenant_id = $1', [tenantId()]);
    if (!s?.provider_cancel_pending) return true;
    try {
      await provider().cancel(s.provider_cancel_pending, { atCycleEnd: false });
    } catch (err) {
      const ended = await provider().fetch(s.provider_cancel_pending).then((sub) => ['cancelled', 'completed', 'expired'].includes(sub?.status), () => false);
      if (!ended) {
        reportError(err, { msg: 'billing.cancel_failed', tenantId: tenantId() });
        return false;
      }
    }
    await q.query('UPDATE subscriptions SET provider_cancel_pending = NULL, updated_at = now() WHERE id = $1 AND provider_cancel_pending = $2', [s.id, s.provider_cancel_pending]);
    return true;
  }

  // ---- the jobs ----

  /** Each business with a live subscription, as { tenantId, ... } rows (a platform read: it looks across businesses). */
  const liveSubscriptions = () => platformDb.query(`SELECT tenant_id, id, current_period_end FROM subscriptions WHERE status = ANY($1::text[]) AND provider_subscription_id IS NOT NULL ORDER BY tenant_id`, [LIVE]);

  /**
   * F-51 (user decision 2026-11-26): a cancelled subscription keeps its plan to the end of the period paid for; once that
   * period has ended the business falls back to Free here. Only a business still on the cancelled subscription's plan, and
   * not moved by Bhava's team since the cancellation, is moved: a console override stands. -> how many fell back
   */
  async function fallBackEnded(done) {
    const rows = await platformDb.query(
      `SELECT s.tenant_id FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.status = 'cancelled' AND t.plan <> 'free' AND t.plan = s.plan AND (s.current_period_end IS NULL OR s.current_period_end <= $1::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM plan_changes c WHERE c.tenant_id = s.tenant_id AND c.source = 'console' AND c.created_at > COALESCE(s.cancelled_at, s.updated_at))
       ORDER BY s.tenant_id`,
      [iso(at())],
    );
    let moved = 0;
    for (const { tenant_id: business } of rows) {
      try {
        if (await withTenant(business, () => syncPlan(business))) moved += 1;
      } catch (err) {
        done.failed += 1;
        reportError(err, { msg: 'billing.fall_back_failed', tenantId: business });
      }
    }
    return moved;
  }

  /**
   * Queues what the next charge must carry, for every live subscription: each new add-on line not yet queued (the retry of a
   * line whose provider answer was lost: always with its first key), each running monthly line once its period is within a
   * day of renewing, and the last months' WhatsApp and AI costs at cost with their counts (F-114). Ended add-ons lose their
   * feature. Safe to run any number of times.
   */
  async function renewals() {
    const settings = await settingsOf(platformDb);
    const done = { queued: 0, passThrough: 0, failed: 0, fellBack: 0 };
    done.fellBack = await fallBackEnded(done);
    if (!complete(settings)) return done;
    // Cancelled subscriptions: lines still open, or a paid period that has since ended with its feature still on (money-10).
    const ending = await platformDb.query(
      `SELECT DISTINCT s.tenant_id FROM subscriptions s JOIN subscription_items i ON i.tenant_id = s.tenant_id JOIN addons a ON a.code = i.addon_code
       WHERE s.status = 'cancelled' AND ((i.ends_at IS NULL AND NOT (i.cycle = 'one_time' AND i.billed_through IS NOT NULL))
         OR (i.ends_at <= now() AND a.feature IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_features f WHERE f.tenant_id = s.tenant_id AND f.feature = a.feature AND f.enabled)))
       ORDER BY s.tenant_id`,
    );
    for (const { tenant_id: business } of ending) {
      await withTenant(business, () => endWithSubscription()).catch((err) => {
        done.failed += 1;
        reportError(err, { msg: 'billing.end_lines_failed', tenantId: business });
      });
    }
    for (const sub of await liveSubscriptions()) {
      await withTenant(sub.tenant_id, async () => {
        try {
          await db.tx(async (t) => switchOffEnded(t));
          const s = await subOf(db);
          const months = monthsOf(s.cycle);
          for (const item of await pendingEnded(db)) await dropPending(item, s);
          const fresh = await db.query(`SELECT * FROM subscription_items WHERE tenant_id = $1 AND provider_item_id IS NULL AND billed_through IS NULL AND (ends_at IS NULL OR ends_at > now()) ORDER BY id`, [tenantId()]);
          for (const item of fresh) if (await queueItem(item, `item:${item.id}:first`, { settings, months })) done.queued += 1;
          const end = s.current_period_end ? new Date(s.current_period_end) : null;
          if (end && end - at() <= QUEUE_AHEAD_MS) {
            // Compared with the period end in the database, not with `end`: that came through the driver, which drops the
            // microseconds Postgres keeps, so a line billed through exactly the period end would look a little past it.
            const due = await db.query(
              `SELECT i.* FROM subscription_items i JOIN subscriptions s ON s.tenant_id = i.tenant_id
               WHERE i.tenant_id = $1 AND i.cycle = 'monthly' AND i.provider_item_id IS NULL AND i.billed_through IS NOT NULL AND i.billed_through <= s.current_period_end
                 AND (i.ends_at IS NULL OR i.ends_at > s.current_period_end) ORDER BY i.id`,
              [tenantId()],
            );
            for (const item of due) if (await queueItem(item, `item:${item.id}:${+end}`, { settings, months, since: new Date(+end - QUEUE_AHEAD_MS) })) done.queued += 1;
            done.passThrough += await queuePassThrough(s, settings);
          }
        } catch (err) {
          done.failed += 1;
          reportError(err, { msg: 'billing.renewal_failed', tenantId: sub.tenant_id });
        }
      });
    }
    return done;
  }

  /**
   * The one writer of pass-through charges to the provider (F-114, 9.10). For every closed month (never this one, which is
   * still counting): the WhatsApp and AI cost rows, written here from usage_months when the hourly usage job has not yet,
   * and every invoice-billed row not yet queued (WhatsApp, AI, and courier charges of a seller billed monthly) are charged
   * at the provider as one line per kind and month, and marked queued_at. Only queued rows go on the invoice (applyCharge),
   * so the invoice lists exactly what the provider takes. The rows are claimed before the provider is asked and released
   * if it fails, so the next run asks again with the same key, which the provider answers with the same line.
   */
  async function queuePassThrough(s, settings) {
    const thisMonth = usageMonthOf(at());
    await db.query(
      `INSERT INTO pass_through_charges (tenant_id, kind, amount_paise, quantity, period, collected_by, source_ref)
       SELECT tenant_id, CASE meter WHEN 'whatsapp_messages' THEN 'whatsapp' ELSE 'ai' END, cost_paise, used, month, 'invoice', 'usage:' || meter || ':' || to_char(month, 'YYYY-MM')
       FROM usage_months WHERE tenant_id = $1 AND meter = ANY($2::text[]) AND month < $3::date AND cost_paise > 0
       ON CONFLICT (tenant_id, kind, source_ref) DO UPDATE SET amount_paise = EXCLUDED.amount_paise, quantity = EXCLUDED.quantity
         WHERE pass_through_charges.invoice_id IS NULL AND pass_through_charges.queued_at IS NULL
           AND (pass_through_charges.amount_paise, pass_through_charges.quantity) IS DISTINCT FROM (EXCLUDED.amount_paise, EXCLUDED.quantity)`,
      [tenantId(), Object.keys(PASS_THROUGH_METERS), thisMonth],
    );
    const buyer = await buyerOf(db, settings);
    let count = 0;
    const due = await db.query(
      `SELECT kind, period, array_agg(id ORDER BY id) AS ids, max(id) AS last FROM pass_through_charges
       WHERE tenant_id = $1 AND collected_by = 'invoice' AND invoice_id IS NULL AND queued_at IS NULL AND period < $2::date AND kind = ANY($3::text[]) AND amount_paise > 0
       GROUP BY kind, period ORDER BY period, kind`,
      [tenantId(), thisMonth, Object.keys(INVOICED_PASS_THROUGH)],
    );
    for (const group of due) {
      const { kind } = group;
      const month = day(group.period).slice(0, 7);
      const claimed = await db.query(
        `UPDATE pass_through_charges SET queued_at = now() WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND queued_at IS NULL AND invoice_id IS NULL RETURNING id, amount_paise, quantity`,
        [tenantId(), group.ids.map(Number)],
      );
      if (!claimed.length) continue;
      const gross = claimed.reduce((sum, r) => sum + Number(r.amount_paise), 0);
      const quantity = claimed.reduce((sum, r) => sum + Number(r.quantity), 0);
      const { name } = INVOICED_PASS_THROUGH[kind];
      const line = taxedLine({ kind: 'pass_through', code: kind, description: name, grossPaise: gross, quantity, rateBp: settings.tax_rate_bp, sellerState: settings.state_code, placeOfSupply: buyer.stateCode || settings.state_code });
      // WhatsApp and AI keep the key they always had (one per kind and month); a month's courier charges are named by their last row.
      const key = kind === 'shipping' ? `pt:${tenantId()}:shipping:${month}:${group.last}` : `pt:${tenantId()}:${kind}:${month}`;
      try {
        // A closed month is charged only once it has closed, so no line for it can be older than the month's end (money-6).
        const made = await provider().addCharge(s.provider_subscription_id, { name, amountPaise: line.totalPaise, quantity: 1, idempotencyKey: key, since: monthEnd(month) });
        await db.query('UPDATE pass_through_charges SET provider_charge_id = $3 WHERE tenant_id = $1 AND id = ANY($2::bigint[])', [tenantId(), claimed.map((r) => Number(r.id)), made?.id ? String(made.id).slice(0, 80) : null]);
      } catch (err) {
        await db.query('UPDATE pass_through_charges SET queued_at = NULL WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND invoice_id IS NULL', [tenantId(), claimed.map((r) => Number(r.id))]);
        throw err;
      }
      count += 1;
    }
    return count;
  }

  /**
   * Grace (F-53): a reminder a day while it runs, then what billing_settings.after_grace says: 'suspend' is an owner-locked
   * pause of every send, with all data kept, lifted only by a payment or by Bhava's team; 'move_to_free' ends the
   * subscription and moves the business to Free.
   */
  async function graceSweep() {
    const settings = await settingsOf(platformDb);
    const nowAt = at();
    const done = { reminded: 0, suspended: 0, freed: 0 };
    const rows = await platformDb.query(`SELECT tenant_id, id, grace_until FROM subscriptions WHERE status IN ('grace', 'past_due') ORDER BY tenant_id`);
    for (const row of rows) {
      await withTenant(row.tenant_id, async () => {
        try {
          if (new Date(row.grace_until) > nowAt) {
            const daysLeft = Math.max(1, Math.ceil((new Date(row.grace_until) - nowAt) / DAY));
            const how = await db.tx((t) => tell(t, {
              kind: 'billing.grace_reminder', key: `billing:grace:${row.id}:${+new Date(row.grace_until)}:${daysLeft}`, data: { days: daysLeft, subscriptionId: Number(row.id) },
              message: `Your Bhava payment is overdue. Sending pauses in ${daysLeft} day${daysLeft === 1 ? '' : 's'} unless it is paid.`,
            }));
            if (how) done.reminded += 1;
            return;
          }
          await ensureCompliance();
          const moved = await locked(async (t) => {
            const [s] = await t.query(`SELECT * FROM subscriptions WHERE tenant_id = $1 AND status IN ('grace', 'past_due') AND grace_until <= $2::timestamptz FOR UPDATE`, [tenantId(), iso(nowAt)]);
            if (!s) return null;
            if (settings.after_grace === 'move_to_free') {
              // The period that went unpaid is not a paid period: it ends now, so the plan falls back at once (F-51).
              await t.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), grace_until = NULL, next_plan = NULL, next_cycle = NULL,
                current_period_end = LEAST(current_period_end, $2::timestamptz), provider_cancel_pending = provider_subscription_id, updated_at = now() WHERE id = $1`, [s.id, iso(nowAt)]);
              await writeAudit(t, { actor: 'billing', action: 'billing.moved_to_free', target: `subscription:${s.id}` });
              return { s, how: 'free' };
            }
            await t.query(`UPDATE subscriptions SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = $1`, [s.id]);
            await holdSends(t);
            await tell(t, { kind: 'billing.suspended', key: `billing:suspended:${s.id}:${+new Date(s.grace_until)}`, data: { subscriptionId: Number(s.id) }, message: 'Sending is paused because your Bhava payment is overdue. Your data is safe. Pay to start again.' });
            await writeAudit(t, { actor: 'billing', action: 'billing.suspended', target: `subscription:${s.id}` });
            return { s, how: 'suspend' };
          });
          if (!moved) return;
          if (moved.how === 'free') {
            done.freed += 1;
            await endWithSubscription();
            await syncPlan(tenantId());
            // Owed until Razorpay has it ended; the billing reconcile tries again (M-6).
            await settleProviderCancel();
          } else {
            done.suspended += 1;
            await syncStatus(tenantId());
            await switchesChanged();
          }
        } catch (err) {
          reportError(err, { msg: 'billing.grace_failed', tenantId: row.tenant_id });
        }
      });
    }
    // A business whose status and subscription disagree (a run stopped between the two writes) is brought into line.
    const drifted = await platformDb.query(
      `SELECT t.id FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
        WHERE (s.status = 'suspended' AND t.status IN ('onboarding', 'active', 'paused'))
           OR (t.status = 'suspended' AND t.billing_suspended_from IS NOT NULL AND s.status IS DISTINCT FROM 'suspended')
        ORDER BY t.id`,
    );
    for (const { id } of drifted) {
      await withTenant(id, () => syncStatus(Number(id))).catch((err) => reportError(err, { msg: 'billing.status_sync_failed', tenantId: id }));
    }
    return done;
  }

  // ---- the Platform Console (platform.js calls these inside withTenant) ----

  const platform = {
    async view() {
      const t = await tenantOf(db);
      const s = await subOf(db);
      const addons = await addonsByCode(db);
      const items = await runningItems(db);
      const overrides = await db.query('SELECT feature, enabled, limit_value FROM tenant_features WHERE tenant_id = $1 ORDER BY feature', [tenantId()]);
      const changes = await db.query('SELECT * FROM plan_changes WHERE tenant_id = $1 ORDER BY id DESC LIMIT 50', [tenantId()]);
      return {
        tenantId: Number(t.id), plan: t.plan, cycle: t.billing_cycle, status: s?.status ?? null, graceUntil: iso(s?.grace_until), periodEnd: iso(s?.current_period_end), offerCode: s?.offer_code ?? null,
        items: items.map((row) => toItem(row, addons)),
        overrides: overrides.map((o) => ({ feature: o.feature, enabled: Boolean(o.enabled), limit: n(o.limit_value) })),
        changes: changes.map((c) => ({ fromPlan: c.from_plan, toPlan: c.to_plan, fromCycle: c.from_cycle, toCycle: c.to_cycle, actor: c.actor, source: c.source, reason: c.reason, at: iso(c.created_at) })),
      };
    },

    async overridePlan({ plan: target, cycle, reason }, actor) {
      const t = await tenantOf(db);
      await platformDb.query(
        `INSERT INTO plan_changes (tenant_id, from_plan, to_plan, from_cycle, to_cycle, actor, source, reason) VALUES ($1, $2, $3, $4, $5, $6, 'console', $7)`,
        [tenantId(), t.plan, target, t.billing_cycle, cycle ?? t.billing_cycle, actor, reason],
      );
      await db.tx(async (tx) => {
        await writeAudit(tx, { actor, action: 'billing.plan_override', target: 'plan', details: { from: t.plan, to: target, cycle: cycle ?? t.billing_cycle, reason } });
        await tell(tx, { kind: 'billing.plan_changed', key: `billing:override:${Date.now()}`, data: {}, message: 'Bhava’s team changed your plan. See Billing for the details.' });
      });
      return platform.view();
    },

    async suspend({ reason }, actor) {
      await ensureCompliance();
      await locked(async (t) => {
        const tenant = await tenantOf(t);
        const s = await subOf(t, { forUpdate: true });
        if (s) await t.query(`UPDATE subscriptions SET status = 'suspended', suspended_at = COALESCE(suspended_at, now()), updated_at = now() WHERE id = $1`, [s.id]);
        else await t.query(`INSERT INTO subscriptions (tenant_id, plan, cycle, status, suspended_at) VALUES ($1, $2, $3, 'suspended', now())`, [tenantId(), tenant.plan, tenant.billing_cycle]);
        await holdSends(t);
        await writeAudit(t, { actor, action: 'billing.suspended', target: 'billing', details: { reason } });
        await tell(t, { kind: 'billing.suspended', key: `billing:hold:${Date.now()}`, data: {}, message: 'Sending is paused for billing. Your data is safe. Contact Bhava to start again.' });
      });
      await syncStatus(tenantId());
      await switchesChanged();
      return platform.view();
    },

    async resume({ reason }, actor) {
      await ensureCompliance();
      await locked(async (t) => {
        const s = await subOf(t, { forUpdate: true });
        if (s && ['suspended', 'grace', 'past_due'].includes(s.status)) {
          await t.query(`UPDATE subscriptions SET status = CASE WHEN cancelled_at IS NOT NULL OR provider_subscription_id IS NULL AND current_period_end IS NULL THEN 'cancelled' ELSE 'active' END,
            grace_until = NULL, suspended_at = NULL, updated_at = now() WHERE id = $1`, [s.id]);
        }
        await releaseSends(t);
        await writeAudit(t, { actor, action: 'billing.resumed', target: 'billing', details: { reason } });
        await tell(t, { kind: 'billing.resumed', key: `billing:release:${Date.now()}`, data: {}, message: 'Bhava is sending again.' });
      });
      await syncStatus(tenantId());
      await switchesChanged();
      return platform.view();
    },

    /** A credit note against an issued invoice: the whole of what is left of it, or part; never more (F-55, 5.12). */
    async creditNote({ invoiceId, taxablePaise, reason }, actor) {
      const settings = await settingsOf(db);
      if (!complete(settings)) throw new ApiError('conflict', 'Set Bhava’s legal name, state and SAC first.', { reason: 'billing_not_ready' });
      const id = await locked(async (t) => {
        const [original] = await t.query(`SELECT * FROM bhava_invoices WHERE tenant_id = $1 AND id = $2 AND doc_type = 'invoice' FOR UPDATE`, [tenantId(), invoiceId]);
        if (!original) throw new ApiError('not_found', 'We couldn’t find that invoice for this business.');
        const lines = await t.query('SELECT * FROM bhava_invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY position', [tenantId(), original.id]);
        const earlierDocs = await t.query(`SELECT id FROM bhava_invoices WHERE tenant_id = $1 AND original_invoice_id = $2`, [tenantId(), original.id]);
        const earlier = earlierDocs.length ? await t.query('SELECT * FROM bhava_invoice_lines WHERE tenant_id = $1 AND invoice_id = ANY($2::bigint[])', [tenantId(), earlierDocs.map((d) => Number(d.id))]) : [];
        const left = Number(original.taxable_paise) - earlier.reduce((total, l) => total + Number(l.taxable_paise), 0);
        const amount = taxablePaise ?? left;
        const intra = Number(original.cgst_paise) > 0 || (Number(original.igst_paise) === 0 && original.place_of_supply === original.seller?.stateCode);
        const credit = creditLines({ original: lines, earlier, amountPaise: amount, intra });
        if (!credit) throw new ApiError('validation_failed', left > 0 ? `A credit note can be for at most ${left} paise of this invoice.` : 'This invoice has been credited in full.', { fields: { taxablePaise: 'More than is left on the invoice' } });
        const doc = await issue(t, {
          docType: 'credit_note', sourceRef: `credit:${original.id}:${earlierDocs.length + 1}`, lines: credit, settings, buyer: original.buyer, placeOfSupply: original.place_of_supply,
          originalInvoiceId: original.id, reason,
        });
        await writeAudit(t, { actor, action: 'billing.credit_note', target: `invoice:${original.id}`, details: { creditNote: doc.number, taxablePaise: amount, reason } });
        return doc.id;
      });
      return invoices.get(id);
    },
  };

  return {
    plan, catalog, change, addItem, removeItem, invoices, issue, syncPlan, renewals, graceSweep, platform, settingsOf, complete, planByProviderId, lastApplied,
    applyCharge, applyFailure, applyCancel, applyPeriod, settleProviderCancel, queueItem, holdSends, releaseSends, financialYearOf, buyerOf, sellerOf, at,
    newRequestKey: () => crypto.randomUUID(),
  };
}
