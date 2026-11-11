import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/errors.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';
import { entitlementsRepo } from '../entitlements/index.js';
import { LOYALTY_FEATURE, MAX_POINTS, dueToExpire, earningBase, keptAfterRefund, pointsFor, redeemable, toSettings } from './rules.js';

/**
 * Loyalty points (PRD 9.21): a ledger per shopper of one business, and the running account beside it.
 *
 *   loyalty_accounts  balance (spendable now) and pending (earned, waiting for the return window). Both are checked >= 0 by
 *                     the database, so no path, and no two checkouts at once, can take an account below zero.
 *   loyalty_ledger    every movement, signed. entry_key is unique per business, so each thing happens once however often
 *                     the event that causes it arrives: 'earn:order:41', 'redeem:order:41', 'reverse:refund:7',
 *                     'restore:order:41', 'referral:12', 'expire:<shopper>:<total>', 'adjust:<uuid>'.
 *
 * Every change to an account runs in one transaction that first locks the account row (lockAccount), lapses whatever has
 * expired, and then moves the ledger and the account together. Where two accounts are touched, they are locked in id order.
 *
 * The life of an order's points:
 *   order.paid            earn, pending, with no date yet (S-87): only a paid order earns, on the amount after discount and
 *                         before shipping, and only with the `loyalty` add-on on and the program enabled (S-91)
 *   order.delivered       the pending points get their date: delivery plus the return window (return_settings)
 *   that date passes      the sweep posts them into the balance, unless a return is still open (then it waits a day)
 *   order.return_window_closed   posts them at once, if the returns module says so first
 *   refund.processed      takes back the part refunded: off the pending points, or out of the balance (S-89)
 *   order.cancelled, order.rto_delivered   gives back points spent on it, and voids what it would have earned
 *   order.reinstated      a cancelled order that came back takes its points again
 * Checkout calls preview() for its quote and redeem(t) inside the order's own transaction (9.5, S-88).
 */
const DAY = 86_400_000;
const OPEN_RETURN = Object.freeze(['requested', 'approved', 'pickup_scheduled', 'picked_up', 'received']);
const NEVER_DELIVERED = Object.freeze(['cancelled', 'rto_initiated', 'rto_delivered']);
const refusal = (message, field = 'redeemPoints') => new ApiError('conflict', message, { fields: { [field]: message } });

export function createLoyalty(ctx) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;

  const featureOn = (q = db) => entitlementsRepo(q).can(LOYALTY_FEATURE);
  async function settingsOf(q = db) {
    const [row] = await q.query('SELECT * FROM loyalty_settings WHERE tenant_id = $1', [tenantId()]);
    return toSettings(row);
  }
  /** The settings when the add-on is on and the owner has enabled the program; otherwise null. */
  async function active(q = db) {
    if (!(await featureOn(q))) return null;
    const settings = await settingsOf(q);
    return settings.enabled ? settings : null;
  }
  const expiryOf = (settings) => (settings.expiryDays ? new Date(Date.now() + settings.expiryDays * DAY) : null);

  // ---- the account -------------------------------------------------------------------------------------------------

  async function dueExpiry(q, shopperId) {
    const [row] = await q.query(
      `SELECT COALESCE(sum(points) FILTER (WHERE points > 0 AND expires_at IS NOT NULL AND expires_at <= now()), 0)::bigint AS expired_credit,
              COALESCE(-sum(points) FILTER (WHERE points < 0), 0)::bigint AS debits
       FROM loyalty_ledger WHERE tenant_id = $1 AND shopper_id = $2 AND status = 'posted'`,
      [tenantId(), shopperId],
    );
    return { due: dueToExpire({ expiredCredit: row.expired_credit, debits: row.debits }), expiredCredit: Number(row.expired_credit) };
  }

  async function entry(t, { shopperId, kind, points, status = 'posted', orderId = null, key, availableAt = null, expiresAt = null, actor = 'system' }) {
    const [row] = await t.query(
      `INSERT INTO loyalty_ledger (tenant_id, shopper_id, kind, points, status, order_id, entry_key, available_at, expires_at, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (tenant_id, entry_key) DO NOTHING RETURNING id`,
      [tenantId(), shopperId, kind, points, status, orderId, key, availableAt, expiresAt, actor],
    );
    return row ? Number(row.id) : null;
  }

  async function move(t, shopperId, { balance = 0, pending = 0 }) {
    const [row] = await t.query(
      'UPDATE loyalty_accounts SET balance = balance + $3, pending = pending + $4, updated_at = now() WHERE tenant_id = $1 AND shopper_id = $2 RETURNING balance, pending',
      [tenantId(), shopperId, balance, pending],
    );
    return row;
  }

  /**
   * Locks one shopper's account for the rest of the transaction, making it when it is new, and lapses what is due first.
   * -> { balance, pending }. Every write to an account starts here.
   */
  async function lockAccount(t, shopperId) {
    await t.query('INSERT INTO loyalty_accounts (tenant_id, shopper_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenantId(), shopperId]);
    const [account] = await t.query('SELECT balance, pending FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2 FOR UPDATE', [tenantId(), shopperId]);
    let { balance } = account;
    const { due, expiredCredit } = await dueExpiry(t, shopperId);
    const take = Math.min(due, balance);
    if (take > 0 && (await entry(t, { shopperId, kind: 'expire', points: -take, key: `expire:${shopperId}:${expiredCredit}` }))) {
      balance -= take;
      log.info('loyalty.expired', { shopperId, points: take });
    }
    await t.query('UPDATE loyalty_accounts SET balance = $3, updated_at = now() WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), shopperId, balance]);
    return { balance, pending: account.pending };
  }

  /** Locks several accounts in id order, so two transactions never wait on each other. */
  async function lockAccounts(t, shopperIds) {
    const out = new Map();
    for (const id of [...new Set(shopperIds.filter(Boolean))].sort((a, b) => a - b)) out.set(id, await lockAccount(t, id));
    return out;
  }

  /** Days after delivery a return may be asked for; 0 when the business takes no returns. */
  async function windowEnd(t, deliveredAt) {
    const [row] = await t.query('SELECT enabled, window_days FROM return_settings WHERE tenant_id = $1', [tenantId()]);
    const days = row?.enabled ? row.window_days : 0;
    return new Date(new Date(deliveredAt ?? Date.now()).getTime() + days * DAY);
  }

  async function voidEntry(t, e) {
    const [row] = await t.query(`UPDATE loyalty_ledger SET status = 'void', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING id`, [tenantId(), e.id]);
    if (!row) return false;
    await move(t, e.shopper_id, { pending: -e.points });
    if (e.kind === 'referral') await t.query(`UPDATE referrals SET status = 'void' WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`, [tenantId(), referralIdOf(e.entry_key)]);
    return true;
  }
  const referralIdOf = (key) => Number(/^referral:(\d+)$/.exec(key)?.[1] ?? 0);

  // ---- order events ------------------------------------------------------------------------------------------------

  /** order.paid: the order earns, pending. Nothing without the add-on, for a guest, or for an order that will never arrive. */
  async function earn(orderId) {
    return db.tx(async (t) => {
      const settings = await active(t);
      if (!settings) return null;
      const [o] = await t.query(
        `SELECT id, flow, shopper_id, subtotal_paise, discount_paise, loyalty_paise, fulfilment_status, payment_status, delivered_at FROM orders WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), orderId],
      );
      if (!o || o.flow !== 'checkout' || !o.shopper_id || NEVER_DELIVERED.includes(o.fulfilment_status) || o.payment_status === 'refunded') return null;
      const points = pointsFor(earningBase(o), settings);
      if (!points) return null;
      await lockAccount(t, o.shopper_id);
      const availableAt = o.fulfilment_status === 'delivered' ? await windowEnd(t, o.delivered_at) : null;
      const id = await entry(t, { shopperId: o.shopper_id, kind: 'earn', points, status: 'pending', orderId, key: `earn:order:${orderId}`, availableAt });
      if (!id) return null;
      await move(t, o.shopper_id, { pending: points });
      log.info('loyalty.earned', { orderId, shopperId: o.shopper_id, points });
      return id;
    });
  }

  /** The referrer's points for a friend's first order, pending until that order's return window closes. */
  async function referralCredit(t, order, availableAt) {
    const settings = await active(t);
    if (!settings?.referralEnabled || !(settings.referrerPoints > 0)) return;
    const refs = await t.query(`SELECT id, referrer_shopper_id FROM referrals WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending' ORDER BY id`, [tenantId(), order.id]);
    for (const ref of refs) {
      await lockAccount(t, ref.referrer_shopper_id);
      const id = await entry(t, { shopperId: ref.referrer_shopper_id, kind: 'referral', points: Math.min(settings.referrerPoints, MAX_POINTS), status: 'pending', orderId: order.id, key: `referral:${ref.id}`, availableAt });
      if (id) await move(t, ref.referrer_shopper_id, { pending: Math.min(settings.referrerPoints, MAX_POINTS) });
    }
  }

  /** order.delivered: the order's pending points get their date, and a friend's first order earns its referrer points. */
  async function delivered(orderId) {
    return db.tx(async (t) => {
      const [o] = await t.query('SELECT id, fulfilment_status, delivered_at FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
      if (!o || o.fulfilment_status !== 'delivered') return;
      const at = await windowEnd(t, o.delivered_at);
      await t.query(
        `UPDATE loyalty_ledger SET available_at = $3, updated_at = now() WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending' AND available_at IS NULL`,
        [tenantId(), orderId, at],
      );
      await referralCredit(t, o, at);
    });
  }

  /** Posts one pending entry when it is due (or now, with `force`). -> 'posted' | 'void' | 'waiting' | 'not_due' | 'gone' */
  async function postEntry(entryId, { force = false } = {}) {
    return db.tx(async (t) => {
      const [peek] = await t.query(`SELECT shopper_id FROM loyalty_ledger WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`, [tenantId(), entryId]);
      if (!peek) return 'gone';
      await lockAccount(t, peek.shopper_id);
      const [e] = await t.query(
        `SELECT *, (available_at IS NOT NULL AND available_at <= now()) AS due FROM loyalty_ledger WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId(), entryId],
      );
      if (!e || e.status !== 'pending') return 'gone';
      if (!force && !e.due) return 'not_due';
      const [o] = e.order_id ? await t.query('SELECT fulfilment_status, payment_status FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), e.order_id]) : [];
      if (!o || o.fulfilment_status !== 'delivered' || o.payment_status === 'refunded') {
        await voidEntry(t, e);
        return 'void';
      }
      const [open] = await t.query('SELECT 1 FROM returns WHERE tenant_id = $1 AND order_id = $2 AND status = ANY($3::text[]) LIMIT 1', [tenantId(), e.order_id, OPEN_RETURN]);
      if (open) {
        // A return asked for inside the window is still open: the points wait for it to end.
        await t.query(`UPDATE loyalty_ledger SET available_at = now() + interval '1 day', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId(), e.id]);
        return 'waiting';
      }
      const settings = await settingsOf(t);
      await t.query(`UPDATE loyalty_ledger SET status = 'posted', expires_at = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId(), e.id, expiryOf(settings)]);
      await move(t, e.shopper_id, { balance: e.points, pending: -e.points });
      if (e.kind === 'referral') {
        await t.query(`UPDATE referrals SET status = 'rewarded', rewarded_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`, [tenantId(), referralIdOf(e.entry_key)]);
      }
      log.info('loyalty.posted', { entryId: Number(e.id), kind: e.kind, shopperId: e.shopper_id, points: e.points });
      return 'posted';
    });
  }

  /** order.return_window_closed: the order's pending points post now. */
  async function windowClosed(orderId) {
    const rows = await db.query(`SELECT id FROM loyalty_ledger WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending' ORDER BY id`, [tenantId(), orderId]);
    for (const row of rows) await postEntry(Number(row.id), { force: true });
  }

  /**
   * refund.processed: the order keeps points in proportion to what is still paid (S-89). Pending points are cut (a full
   * refund voids them); posted points are taken back out of the balance, as far as the balance goes. Worked out from the
   * order's totals each time, so a repeated event or two refunds in a row take back exactly what is due.
   */
  async function refunded(orderId, refundId) {
    return db.tx(async (t) => {
      const [o] = await t.query('SELECT id, shopper_id, paid_paise, refunded_paise, payment_status FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
      if (!o) return;
      const referrals = await t.query(`SELECT * FROM loyalty_ledger WHERE tenant_id = $1 AND order_id = $2 AND kind = 'referral' AND status = 'pending'`, [tenantId(), orderId]);
      const fullyRefunded = o.payment_status === 'refunded' || Number(o.refunded_paise) >= Number(o.paid_paise);
      await lockAccounts(t, [o.shopper_id, ...(fullyRefunded ? referrals.map((r) => r.shopper_id) : [])]);
      // A friend's order refunded in full earns its referrer nothing.
      if (fullyRefunded) for (const r of referrals) await voidEntry(t, r);
      if (!o.shopper_id) return;

      const rows = await t.query(
        `SELECT * FROM loyalty_ledger WHERE tenant_id = $1 AND order_id = $2 AND shopper_id = $3 AND kind IN ('earn', 'reverse') ORDER BY id FOR UPDATE`,
        [tenantId(), orderId, o.shopper_id],
      );
      const original = rows.find((r) => r.entry_key === `earn:order:${orderId}`);
      const current = rows.filter((r) => r.kind === 'earn' && r.status !== 'void').at(-1);
      if (!original || !current) return;
      const target = keptAfterRefund(original.points, o.paid_paise, o.refunded_paise);

      if (current.status === 'pending') {
        if (target >= current.points) return;
        await voidEntry(t, current);
        if (target > 0) {
          const id = await entry(t, { shopperId: o.shopper_id, kind: 'earn', points: target, status: 'pending', orderId, key: `earn:order:${orderId}:refund:${refundId}`, availableAt: current.available_at });
          if (id) await move(t, o.shopper_id, { pending: target });
        }
        log.info('loyalty.refund_cut', { orderId, refundId, from: current.points, to: target });
        return;
      }
      const reversed = -rows.filter((r) => r.kind === 'reverse').reduce((sum, r) => sum + r.points, 0);
      const take = current.points - reversed - target;
      if (take <= 0) return;
      const [{ balance }] = await t.query('SELECT balance FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), o.shopper_id]);
      const taken = Math.min(take, balance);
      if (taken > 0 && (await entry(t, { shopperId: o.shopper_id, kind: 'reverse', points: -taken, orderId, key: `reverse:refund:${refundId}` }))) {
        await move(t, o.shopper_id, { balance: -taken });
      }
      // Points already spent can't be taken back below zero; the rest is written off, and said so in the log.
      log.info('loyalty.reversed', { orderId, refundId, points: taken, short: take - taken });
    });
  }

  /** order.cancelled and order.rto_delivered: points spent on it come back, and what it would have earned is voided. */
  async function cancelled(orderId) {
    return db.tx(async (t) => {
      const [o] = await t.query('SELECT id, shopper_id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
      if (!o) return;
      const pending = await t.query(`SELECT * FROM loyalty_ledger WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending' ORDER BY id`, [tenantId(), orderId]);
      await lockAccounts(t, [o.shopper_id, ...pending.map((e) => e.shopper_id)]);
      for (const e of pending) await voidEntry(t, e);
      await t.query(`UPDATE referrals SET status = 'void' WHERE tenant_id = $1 AND order_id = $2 AND status = 'pending'`, [tenantId(), orderId]);
      if (!o.shopper_id) return;
      const spent = await t.query(
        `SELECT kind, points FROM loyalty_ledger WHERE tenant_id = $1 AND order_id = $2 AND shopper_id = $3 AND kind IN ('redeem', 'restore') ORDER BY id`,
        [tenantId(), orderId, o.shopper_id],
      );
      const redeems = spent.filter((e) => e.kind === 'redeem');
      const restores = spent.filter((e) => e.kind === 'restore');
      if (redeems.length <= restores.length) return;
      const points = -redeems.at(-1).points;
      const key = restores.length ? `restore:order:${orderId}:${restores.length + 1}` : `restore:order:${orderId}`;
      const settings = await settingsOf(t);
      if (await entry(t, { shopperId: o.shopper_id, kind: 'restore', points, orderId, key, expiresAt: expiryOf(settings) })) {
        await move(t, o.shopper_id, { balance: points });
        log.info('loyalty.restored', { orderId, shopperId: o.shopper_id, points });
      }
    });
  }

  /** order.reinstated: a cancelled order whose payment arrived late is back, so the points it used are taken again. */
  async function reinstated(orderId) {
    return db.tx(async (t) => {
      const [o] = await t.query('SELECT id, shopper_id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), orderId]);
      if (!o?.shopper_id) return;
      const { balance } = await lockAccount(t, o.shopper_id);
      const spent = await t.query(
        `SELECT kind, points FROM loyalty_ledger WHERE tenant_id = $1 AND order_id = $2 AND shopper_id = $3 AND kind IN ('redeem', 'restore') ORDER BY id`,
        [tenantId(), orderId, o.shopper_id],
      );
      const redeems = spent.filter((e) => e.kind === 'redeem');
      const restores = spent.filter((e) => e.kind === 'restore');
      if (!restores.length || restores.length < redeems.length) return;
      const want = restores.at(-1).points;
      const taken = Math.min(want, balance);
      if (taken > 0 && (await entry(t, { shopperId: o.shopper_id, kind: 'redeem', points: -taken, orderId, key: `redeem:order:${orderId}:${redeems.length + 1}` }))) {
        await move(t, o.shopper_id, { balance: -taken });
      }
      log.info('loyalty.retaken', { orderId, shopperId: o.shopper_id, points: taken, short: want - taken });
    });
  }

  // ---- checkout ----------------------------------------------------------------------------------------------------

  /**
   * How many of the points asked for this order may use (S-88). `q` is the order's transaction when checkout places it: the
   * account row is then locked until that transaction ends, so a second checkout waits and sees what the first one left.
   * -> { points, valuePaise, notice }
   */
  async function preview({ shopperId, points, orderPaise }, q = db) {
    const none = { points: 0, valuePaise: 0, notice: '' };
    if (!shopperId || !(points > 0) || !(orderPaise > 0)) return none;
    const settings = await active(q);
    if (!settings) return none;
    const [account] = await q.query(`SELECT balance FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2${q === db ? '' : ' FOR UPDATE'}`, [tenantId(), shopperId]);
    if (!account) return none;
    const balance = account.balance - (await dueExpiry(q, shopperId)).due;
    return redeemable({ requested: points, balance, cap: settings.maxRedeemPoints, pointValuePaise: settings.pointValuePaise, orderPaise });
  }

  /**
   * Spends points on an order, inside the order's transaction (9.5): checked again against the add-on, the cap, the value
   * and the balance, then taken. A refusal is a conflict, which rolls the order back.
   */
  async function redeem(t, { shopperId, orderId, points, valuePaise }) {
    if (!shopperId || !Number.isSafeInteger(points) || points <= 0) throw refusal('Points can’t be used on this order.');
    const settings = await active(t);
    if (!settings) throw refusal('Points can’t be used on this order.');
    if (points > settings.maxRedeemPoints) throw refusal(`You can use up to ${settings.maxRedeemPoints} points on one order.`);
    if (!Number.isSafeInteger(valuePaise) || valuePaise < 0 || valuePaise > points * settings.pointValuePaise) throw refusal('Your points changed. Please check your order and try again.');
    const { balance } = await lockAccount(t, shopperId);
    if (balance < points) throw refusal('You don’t have enough points for this any more. Please check your order and try again.');
    if (!(await entry(t, { shopperId, kind: 'redeem', points: -points, orderId, key: `redeem:order:${orderId}`, actor: `shopper:${shopperId}` }))) {
      throw refusal('Points were already used on this order.');
    }
    await move(t, shopperId, { balance: -points });
    log.info('loyalty.redeemed', { orderId, shopperId, points });
  }

  // ---- the owner ---------------------------------------------------------------------------------------------------

  async function needPlan() {
    if (!(await featureOn())) throw new ApiError('forbidden', 'Loyalty points are an add-on that isn’t on your plan.', { reason: 'plan' });
  }

  const SETTING_COLUMNS = Object.freeze({
    enabled: 'enabled', earnPoints: 'earn_points', earnPerPaise: 'earn_per_paise', pointValuePaise: 'point_value_paise', maxRedeemPoints: 'max_redeem_points',
    expiryDays: 'expiry_days', referralEnabled: 'referral_enabled', friendRewardPaise: 'friend_reward_paise', referrerPoints: 'referrer_points',
  });
  const settingsView = (settings) => ({ available: true, ...settings });

  async function getSettings() {
    await needPlan();
    return settingsView(await settingsOf());
  }

  async function updateSettings(patch, actor) {
    await needPlan();
    const changed = Object.keys(patch).filter((k) => Object.hasOwn(SETTING_COLUMNS, k) && patch[k] !== undefined);
    if (changed.some((k) => ['earnPoints', 'maxRedeemPoints', 'referrerPoints'].includes(k) && patch[k] > MAX_POINTS)) {
      throw new ApiError('validation_failed', `Use ${MAX_POINTS} points or fewer.`, { fields: Object.fromEntries(changed.filter((k) => patch[k] > MAX_POINTS).map((k) => [k, 'That number is too large'])) });
    }
    const next = await db.tx(async (t) => {
      const merged = { ...(await settingsOf(t)), ...Object.fromEntries(changed.map((k) => [k, patch[k]])) };
      const columns = Object.values(SETTING_COLUMNS);
      const values = Object.keys(SETTING_COLUMNS).map((k) => merged[k]);
      await t.query(
        `INSERT INTO loyalty_settings (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (tenant_id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
        [tenantId(), ...values],
      );
      await writeAudit(t, { actor, action: 'loyalty.settings_updated', target: 'loyalty_settings', details: Object.fromEntries(changed.map((k) => [k, patch[k]])) });
      return merged;
    });
    return settingsView(next);
  }

  const toMember = (row) => ({ shopperId: row.shopper_id, name: row.name ?? '', balance: row.balance, pending: row.pending, updatedAt: row.updated_at });
  const toEntry = (row) => ({
    id: Number(row.id), kind: row.kind, points: row.points, status: row.status, orderId: row.order_id, availableAt: row.available_at, expiresAt: row.expires_at, at: row.created_at,
  });

  async function shopperHere(shopperId) {
    const [row] = await db.query('SELECT id, name FROM shoppers WHERE tenant_id = $1 AND id = $2', [tenantId(), shopperId]);
    return row ?? null;
  }

  async function member(shopperId) {
    const [row] = await db.query(
      `SELECT s.id AS shopper_id, s.name, COALESCE(a.balance, 0) AS balance, COALESCE(a.pending, 0) AS pending, COALESCE(a.updated_at, s.created_at) AS updated_at
       FROM shoppers s LEFT JOIN loyalty_accounts a ON a.tenant_id = s.tenant_id AND a.shopper_id = s.id WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenantId(), shopperId],
    );
    return row ? toMember(row) : null;
  }

  /** The owner gives or takes points by hand, with a reason (owner only). Taking more than the balance is refused. */
  async function adjust(shopperId, { points, note }, actor) {
    await needPlan();
    if (!(await shopperHere(shopperId))) return null;
    if (Math.abs(points) > MAX_POINTS) throw new ApiError('validation_failed', 'That number is too large.', { fields: { points: 'That number is too large' } });
    await db.tx(async (t) => {
      const { balance } = await lockAccount(t, shopperId);
      if (points < 0 && balance < -points) throw new ApiError('validation_failed', `They have ${balance} points to take from.`, { fields: { points: `They have ${balance} points` } });
      const settings = await settingsOf(t);
      await entry(t, { shopperId, kind: 'adjust', points, key: `adjust:${crypto.randomUUID()}`, actor, expiresAt: points > 0 ? expiryOf(settings) : null });
      await move(t, shopperId, { balance: points });
      await writeAudit(t, { actor, action: 'loyalty.adjusted', target: `shopper:${shopperId}`, details: { points, note: String(note ?? '').slice(0, 200) } });
    });
    log.info('loyalty.adjusted', { shopperId, points });
    return member(shopperId);
  }

  async function members({ cursor, limit }) {
    await needPlan();
    const after = cursor ? readCursor(cursor, (k) => k.length === 1 && Number.isSafeInteger(k[0]) && k[0] > 0)[0] : null;
    const rows = await db.query(
      `SELECT a.shopper_id, s.name, a.balance, a.pending, a.updated_at FROM loyalty_accounts a JOIN shoppers s ON s.tenant_id = a.tenant_id AND s.id = a.shopper_id
       WHERE a.tenant_id = $1 AND ($2::int IS NULL OR a.shopper_id < $2) ORDER BY a.shopper_id DESC LIMIT $3`,
      [tenantId(), after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (r) => [r.shopper_id]);
    return { items: page.items.map(toMember), nextCursor: page.nextCursor };
  }

  async function ledger(shopperId, { cursor, limit }) {
    await needPlan();
    if (!(await shopperHere(shopperId))) return null;
    const after = cursor ? readCursor(cursor, (k) => k.length === 1 && Number.isSafeInteger(k[0]) && k[0] > 0)[0] : null;
    const rows = await db.query(
      `SELECT * FROM loyalty_ledger WHERE tenant_id = $1 AND shopper_id = $2 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
      [tenantId(), shopperId, after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (r) => [Number(r.id)]);
    return { items: page.items.map(toEntry), nextCursor: page.nextCursor };
  }

  async function referralList({ cursor, limit }) {
    await needPlan();
    const after = cursor ? readCursor(cursor, (k) => k.length === 1 && Number.isSafeInteger(k[0]) && k[0] > 0)[0] : null;
    const rows = await db.query(
      `SELECT id, referrer_shopper_id, status, block_reason, order_id, created_at FROM referrals WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [tenantId(), after, limit + 1],
    );
    const page = pageOfFetched(rows, limit, (r) => [Number(r.id)]);
    return {
      items: page.items.map((r) => ({ id: Number(r.id), referrerShopperId: r.referrer_shopper_id, status: r.status, blockReason: r.block_reason, orderId: r.order_id, createdAt: r.created_at })),
      nextCursor: page.nextCursor,
    };
  }

  // ---- the shopper -------------------------------------------------------------------------------------------------

  /** The shopper's own account, as the points page shows it: what has lapsed by now is already left out. */
  async function account(shopperId) {
    const [row] = await db.query('SELECT balance, pending FROM loyalty_accounts WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), shopperId]);
    if (!row) return { balance: 0, pending: 0 };
    return { balance: Math.max(0, row.balance - (await dueExpiry(db, shopperId)).due), pending: row.pending };
  }

  async function history(shopperId, limit = 50) {
    return db.query(
      `SELECT l.id, l.kind, l.points, l.status, l.available_at, l.expires_at, l.created_at, o.order_number
       FROM loyalty_ledger l LEFT JOIN orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
       WHERE l.tenant_id = $1 AND l.shopper_id = $2 ORDER BY l.id DESC LIMIT $3`,
      [tenantId(), shopperId, limit],
    );
  }

  // ---- the sweep ---------------------------------------------------------------------------------------------------

  /** Posts what is due and lapses what has expired, for every business. Run by the worker every few minutes. */
  async function sweep({ limit = 200 } = {}) {
    const due = await platformDb.query(`SELECT tenant_id, id FROM loyalty_ledger WHERE status = 'pending' AND available_at <= now() ORDER BY available_at, id LIMIT $1`, [limit]);
    let posted = 0;
    for (const row of due) {
      try {
        if ((await withTenant(row.tenant_id, () => postEntry(Number(row.id)))) === 'posted') posted++;
      } catch (err) {
        reportError(err, { msg: 'loyalty.post_failed', tenantId: row.tenant_id, entryId: Number(row.id) });
      }
    }
    // Lots that lapsed since the account last changed (every change lapses what is due first). A lot older than a month
    // that was missed here still lapses the next time its account changes, and pages already leave it out.
    const lapsing = await platformDb.query(
      `SELECT DISTINCT l.tenant_id, l.shopper_id FROM loyalty_ledger l JOIN loyalty_accounts a ON a.tenant_id = l.tenant_id AND a.shopper_id = l.shopper_id
       WHERE l.status = 'posted' AND l.points > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= now() AND l.expires_at > now() - interval '30 days'
         AND l.expires_at > a.updated_at
       LIMIT $1`,
      [limit],
    );
    for (const row of lapsing) {
      try {
        await withTenant(row.tenant_id, () => db.tx((t) => lockAccount(t, row.shopper_id)));
      } catch (err) {
        reportError(err, { msg: 'loyalty.expire_failed', tenantId: row.tenant_id, shopperId: row.shopper_id });
      }
    }
    return { posted, lapsed: lapsing.length };
  }

  return {
    active, settingsOf, featureOn, needPlan,
    earn, delivered, postEntry, windowClosed, refunded, cancelled, reinstated, referralCredit, windowEnd, lockAccount, entry, move,
    preview, redeem,
    getSettings, updateSettings, adjust, members, ledger, referralList, member,
    account, history, sweep,
  };
}
