import crypto from 'node:crypto';
import { STORE_LIMITS, INDIAN_STATES } from '../../contracts/orders.js';
import { AddressInput } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { keyedHash, newToken, safeEqual, toE164, tokenHash } from './keys.js';

/**
 * Shoppers of one business (PRD 9.3, 9.4): the people, their sign-ins on each device, one-time codes and saved addresses.
 * Every call runs for the current business and names it in every query. A shopper is never a seller: these rows live in
 * `shoppers` and `shopper_sessions`, which the seller's sign-in (src/auth.js) never reads.
 *
 * One-time codes: 6 digits from the system's random source, kept only as a keyed hash that also covers the code's own row
 * (so a hash from one row proves nothing about another), good for 5 minutes, dead after 3 wrong tries or the first right
 * one, and replaced by any newer code for the same number and purpose. Neither the code nor the number is ever logged.
 */
export const SESSION_DAYS = 30;
const MAX_ADDRESSES = 20;
const OTP = STORE_LIMITS.otp;
const HOUR_MS = 3_600_000;

export class OtpError extends Error {
  constructor(code, message, { status = 400, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'OtpError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const PUBLIC = 'id, phone, phone_verified_at, google_sub, email, name, created_at, last_seen_at, erased_at';
const toShopper = (row) => (row ? { id: row.id, phone: row.phone ?? '', email: row.email, name: row.name, hasGoogle: Boolean(row.google_sub), phoneVerified: Boolean(row.phone_verified_at), createdAt: row.created_at } : null);
const toAddress = (row) => ({
  id: row.id, name: row.name, phone: row.phone, line1: row.line1, line2: row.line2, landmark: row.landmark, city: row.city,
  stateCode: row.state_code, state: INDIAN_STATES[row.state_code] ?? '', pincode: row.pincode, kind: row.kind, isDefault: row.is_default, shared: false,
});

/** Checks an address as the contract's schema does, and that the state is one of the list and the phone a real number. */
export function parseAddress(input) {
  const parsed = AddressInput.safeParse(input);
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0] ?? 'address'), issue.message]));
    throw Object.assign(new ValidationError(Object.values(fields)[0] ?? 'Please check the address.'), { fields });
  }
  const phone = toE164(parsed.data.phone);
  if (!phone) throw Object.assign(new ValidationError('Enter a valid mobile number'), { fields: { phone: 'Enter a valid mobile number' } });
  if (!INDIAN_STATES[parsed.data.stateCode]) throw Object.assign(new ValidationError('Pick your state'), { fields: { stateCode: 'Pick your state' } });
  return { ...parsed.data, phone };
}

export function createShopperService({ db, config, platform, shopperMessages }) {
  const phoneHash = (phone) => keyedHash(config, `phone:${tenantId()}`, phone);
  const codeHash = (otpId, code) => keyedHash(config, `otp:${tenantId()}:${otpId}`, code);

  const shoppers = {
    async get(id, runner = db) {
      const [row] = await runner.query(`SELECT ${PUBLIC} FROM shoppers WHERE tenant_id = $1 AND id = $2 AND erased_at IS NULL`, [tenantId(), id]);
      return toShopper(row);
    },

    /** The shopper with this verified number at this business, made on first sign-in. */
    async forVerifiedPhone(phone, runner = db) {
      const [row] = await runner.query(
        `INSERT INTO shoppers (tenant_id, phone, phone_verified_at, last_seen_at) VALUES ($1, $2, now(), now())
         ON CONFLICT (tenant_id, phone) WHERE phone IS NOT NULL DO UPDATE SET phone_verified_at = COALESCE(shoppers.phone_verified_at, now()), last_seen_at = now()
         RETURNING ${PUBLIC}`,
        [tenantId(), phone],
      );
      return toShopper(row);
    },

    /** The shopper with this Google account at this business. The name and email are Google's, taken once and then the shopper's to change. */
    async forGoogle({ sub, email = '', name = '' }, runner = db) {
      const [row] = await runner.query(
        `INSERT INTO shoppers (tenant_id, google_sub, email, name, last_seen_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, google_sub) WHERE google_sub IS NOT NULL DO UPDATE SET last_seen_at = now(),
           email = CASE WHEN shoppers.email = '' THEN EXCLUDED.email ELSE shoppers.email END,
           name = CASE WHEN shoppers.name = '' THEN EXCLUDED.name ELSE shoppers.name END
         RETURNING ${PUBLIC}`,
        [tenantId(), String(sub).slice(0, 255), String(email).slice(0, 254), String(name).slice(0, 80)],
      );
      return toShopper(row);
    },

    /** How this shopper proved who they are: the verified phone and the Google account id. For the shared profile only; never shown. */
    async identity(id) {
      const [row] = await db.query('SELECT phone, phone_verified_at, google_sub FROM shoppers WHERE tenant_id = $1 AND id = $2 AND erased_at IS NULL', [tenantId(), id]);
      return row ? { phone: row.phone_verified_at ? row.phone : null, googleSub: row.google_sub ?? null } : null;
    },

    async setProfile(id, { name, email }) {
      const [row] = await db.query(
        `UPDATE shoppers SET name = COALESCE($3, name), email = COALESCE($4, email) WHERE tenant_id = $1 AND id = $2 AND erased_at IS NULL RETURNING ${PUBLIC}`,
        [tenantId(), id, name === undefined ? null : String(name).trim().slice(0, 80), email === undefined ? null : String(email).trim().slice(0, 254)],
      );
      return toShopper(row);
    },
  };

  const sessions = {
    /** Starts a sign-in on this device and returns the token for the cookie. Only its hash is stored. */
    async create(shopperId, method, runner = db) {
      const token = newToken();
      await runner.query(
        `INSERT INTO shopper_sessions (tenant_id, shopper_id, token_hash, method, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [tenantId(), shopperId, tokenHash(token), method, SESSION_DAYS],
      );
      return token;
    },

    /** The shopper a cookie's token belongs to at this business, or null: unknown, expired, signed out, erased, or another business's. */
    async shopperFor(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      const [row] = await db.query(
        `SELECT s.id AS session_id, s.last_used_at, s.method, ${PUBLIC.split(', ').map((c) => `p.${c}`).join(', ')}
         FROM shopper_sessions s JOIN shoppers p ON p.tenant_id = s.tenant_id AND p.id = s.shopper_id
         WHERE s.tenant_id = $1 AND s.token_hash = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND p.erased_at IS NULL`,
        [tenantId(), tokenHash(token)],
      );
      if (!row) return null;
      if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 5 * 60_000) {
        await db.query('UPDATE shopper_sessions SET last_used_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), row.session_id]);
      }
      return { ...toShopper(row), method: row.method };
    },

    async revoke(token) {
      await db.query('UPDATE shopper_sessions SET revoked_at = now() WHERE tenant_id = $1 AND token_hash = $2 AND revoked_at IS NULL', [tenantId(), tokenHash(String(token))]);
    },

    async revokeAll(shopperId, runner = db) {
      await runner.query('UPDATE shopper_sessions SET revoked_at = now() WHERE tenant_id = $1 AND shopper_id = $2 AND revoked_at IS NULL', [tenantId(), shopperId]);
    },
  };

  const otps = {
    /**
     * Sends a code by WhatsApp through the shopper-message gate. Refused, with nothing sent, on the 6th send to one number
     * in an hour (S-09) or too many from one address. Says the same thing whether or not the number has an account here.
     */
    async send({ phone, purpose, checkoutKey = '', ip = '' }) {
      const e164 = toE164(phone);
      if (!e164) throw new OtpError('validation_failed', 'Enter a valid mobile number');
      if (!['sign_in', 'cod'].includes(purpose) || (purpose === 'cod' && !checkoutKey)) throw new OtpError('validation_failed', 'Please start again from the checkout.');
      const wait = (ms) => new OtpError('rate_limited', `Too many codes requested. Try again in ${Math.max(1, Math.ceil(ms / 60_000))} minutes.`, { status: 429, retryAfterMs: ms });
      const byIp = await platform.rateLimit.hit('otp_sends_ip', String(ip), { limit: OTP.sendsPerIpPerHour, windowMs: HOUR_MS });
      if (!byIp.allowed) throw wait(byIp.retryAfterMs);
      const hash = phoneHash(e164);
      const byNumber = await platform.rateLimit.hit('otp_sends', `${tenantId()}:${hash}`, { limit: OTP.sendsPerHour, windowMs: HOUR_MS });
      if (!byNumber.allowed) throw wait(byNumber.retryAfterMs);

      const code = String(crypto.randomInt(0, 10 ** OTP.digits)).padStart(OTP.digits, '0');
      const id = await db.tx(async (t) => {
        // A newer code replaces every older one for this number and purpose.
        await t.query(
          `UPDATE shopper_otps SET invalidated_at = now() WHERE tenant_id = $1 AND phone_hash = $2 AND purpose = $3 AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [tenantId(), hash, purpose],
        );
        const [row] = await t.query(
          `INSERT INTO shopper_otps (tenant_id, purpose, phone_hash, code_hash, checkout_key, expires_at)
           VALUES ($1, $2, $3, repeat('0', 64), $4, now() + make_interval(secs => $5)) RETURNING id`,
          [tenantId(), purpose, hash, String(checkoutKey).slice(0, 80), OTP.validMs / 1000],
        );
        await t.query('UPDATE shopper_otps SET code_hash = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id, codeHash(row.id, code)]);
        return row.id;
      });

      const sent = await shopperMessages.send({ channel: 'whatsapp', purpose: 'authentication', to: { phone: e164 }, template: { purpose: 'otp', params: [code] } });
      if (sent.outcome !== 'sent') {
        await db.query('UPDATE shopper_otps SET invalidated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
        log.warn('shopper.otp_not_sent', { otpId: Number(id), reason: sent.reason });
        throw new OtpError('unavailable', 'We couldn’t send a code just now. Please try again in a little while.', { status: 503 });
      }
      log.info('shopper.otp_sent', { otpId: Number(id), purpose });
      return { sent: true, expiresInSeconds: OTP.validMs / 1000 };
    },

    /**
     * Checks a code. Right: the row is used up and can never be used again. Wrong: one of three tries is spent, and the third
     * kills the code (S-08). The row is locked while it is checked, so many guesses sent at once still get three tries between them.
     * Returns { phone } (E.164). Throws OtpError otherwise, with one message for wrong, expired and unknown.
     */
    async verify({ phone, purpose, code, checkoutKey = '' }) {
      const e164 = toE164(phone);
      const wrong = () => new OtpError('validation_failed', 'That code isn’t right or has expired. Check it, or ask for a new one.');
      if (!e164 || !/^[0-9]+$/.test(String(code)) || (purpose === 'cod' && !checkoutKey)) throw wrong();
      const hash = phoneHash(e164);
      const run = async (tx) => {
        const [row] = await tx.query(
          `SELECT id, code_hash, attempts, checkout_key FROM shopper_otps
           WHERE tenant_id = $1 AND phone_hash = $2 AND purpose = $3 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
           ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [tenantId(), hash, purpose],
        );
        if (!row) return { ok: false };
        const right = safeEqual(row.code_hash, codeHash(row.id, String(code))) && (purpose !== 'cod' || row.checkout_key === String(checkoutKey));
        if (!right) {
          const attempts = row.attempts + 1;
          await tx.query(
            `UPDATE shopper_otps SET attempts = $3::int, invalidated_at = CASE WHEN $3::int >= $4::int THEN now() ELSE NULL END WHERE tenant_id = $1 AND id = $2`,
            [tenantId(), row.id, attempts, OTP.wrongTries],
          );
          return { ok: false, dead: attempts >= OTP.wrongTries, id: Number(row.id) };
        }
        await tx.query('UPDATE shopper_otps SET consumed_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id]);
        return { ok: true, id: Number(row.id) };
      };
      // The spent try must stay spent even when the caller's own transaction rolls back, so the check commits on its own.
      const result = await db.tx(run);
      if (!result.ok) {
        if (result.dead) {
          log.info('shopper.otp_locked', { otpId: result.id });
          throw new OtpError('validation_failed', 'That code was entered wrongly too many times. Ask for a new one.');
        }
        throw wrong();
      }
      return { phone: e164, otpId: result.id };
    },

    /** Has this number proved itself for this checkout attempt (9.5)? True for 30 minutes after the cash-on-delivery code was entered. */
    async codVerified({ phone, checkoutKey }) {
      const e164 = toE164(phone);
      if (!e164 || !checkoutKey) return false;
      const [row] = await db.query(
        `SELECT 1 FROM shopper_otps WHERE tenant_id = $1 AND phone_hash = $2 AND purpose = 'cod' AND checkout_key = $3 AND consumed_at > now() - interval '30 minutes' LIMIT 1`,
        [tenantId(), phoneHash(e164), String(checkoutKey)],
      );
      return Boolean(row);
    },
  };

  const addresses = {
    async list(shopperId, runner = db) {
      const rows = await runner.query('SELECT * FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY is_default DESC, id', [tenantId(), shopperId]);
      return rows.map(toAddress);
    },

    async get(shopperId, id) {
      const [row] = await db.query('SELECT * FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 AND id = $3', [tenantId(), shopperId, id]);
      return row ? toAddress(row) : null;
    },

    /** Saves a new address. The first one is the default; marking another as default takes it from the old one (S-13). */
    async create(shopperId, input) {
      const a = parseAddress(input);
      return db.tx(async (t) => {
        // One shopper's addresses change one at a time, so the count and the single default hold.
        await t.query('SELECT 1 FROM shoppers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), shopperId]);
        const [{ n }] = await t.query('SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [tenantId(), shopperId]);
        if (n >= MAX_ADDRESSES) throw new ValidationError(`You can save up to ${MAX_ADDRESSES} addresses. Remove one to add another.`);
        const makeDefault = a.isDefault || n === 0;
        if (makeDefault) await t.query('UPDATE shopper_addresses SET is_default = false WHERE tenant_id = $1 AND shopper_id = $2 AND is_default', [tenantId(), shopperId]);
        const [row] = await t.query(
          `INSERT INTO shopper_addresses (tenant_id, shopper_id, name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [tenantId(), shopperId, a.name, a.phone, a.line1, a.line2, a.landmark, a.city, a.stateCode, a.pincode, a.kind, makeDefault],
        );
        return toAddress(row);
      });
    },

    /** Changes a saved address. Past orders hold their own copy, so they do not change (S-14). null when it isn't this shopper's. */
    async update(shopperId, id, input) {
      const a = parseAddress(input);
      return db.tx(async (t) => {
        await t.query('SELECT 1 FROM shoppers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), shopperId]);
        const [current] = await t.query('SELECT id, is_default FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 AND id = $3', [tenantId(), shopperId, id]);
        if (!current) return null;
        const makeDefault = a.isDefault || current.is_default;
        if (a.isDefault && !current.is_default) await t.query('UPDATE shopper_addresses SET is_default = false WHERE tenant_id = $1 AND shopper_id = $2 AND is_default', [tenantId(), shopperId]);
        const [row] = await t.query(
          `UPDATE shopper_addresses SET name = $4, phone = $5, line1 = $6, line2 = $7, landmark = $8, city = $9, state_code = $10, pincode = $11, kind = $12, is_default = $13, updated_at = now()
           WHERE tenant_id = $1 AND shopper_id = $2 AND id = $3 RETURNING *`,
          [tenantId(), shopperId, id, a.name, a.phone, a.line1, a.line2, a.landmark, a.city, a.stateCode, a.pincode, a.kind, makeDefault],
        );
        return toAddress(row);
      });
    },

    /** Removes one. If it was the default, the oldest one left becomes the default. */
    async remove(shopperId, id) {
      return db.tx(async (t) => {
        await t.query('SELECT 1 FROM shoppers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId(), shopperId]);
        const [gone] = await t.query('DELETE FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 AND id = $3 RETURNING is_default', [tenantId(), shopperId, id]);
        if (!gone) return false;
        if (gone.is_default) {
          await t.query(
            `UPDATE shopper_addresses SET is_default = true WHERE tenant_id = $1 AND id = (SELECT id FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id LIMIT 1)`,
            [tenantId(), shopperId],
          );
        }
        return true;
      });
    },
  };

  /** The shopper's own orders at this business, newest first. Never another shopper's, and never another business's (S-11). */
  const orders = {
    async list(shopperId, { limit = 50 } = {}) {
      return db.query(
        `SELECT id, order_number, public_token, status, fulfilment_status, payment_status, payment_mode, total_paise, created_at
         FROM orders WHERE tenant_id = $1 AND shopper_id = $2 AND erased_at IS NULL ORDER BY id DESC LIMIT $3`,
        [tenantId(), shopperId, limit],
      );
    },

    async get(shopperId, orderNumber) {
      const [order] = await db.query(
        `SELECT id, order_number, public_token, flow, status, fulfilment_status, payment_status, payment_mode, subtotal_paise, discount_paise, loyalty_paise, shipping_paise, cod_fee_paise,
                total_paise, shipping_address, customer_name, address, city, state, pincode, created_at, shipped_at, delivered_at, cancelled_at
         FROM orders WHERE tenant_id = $1 AND shopper_id = $2 AND order_number = $3 AND erased_at IS NULL`,
        [tenantId(), shopperId, String(orderNumber).slice(0, 40)],
      );
      if (!order) return null;
      const items = await db.query('SELECT name, option_value, qty, price_paise FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY id', [tenantId(), order.id]);
      const invoices = await db.query(`SELECT number, doc_type, total_paise, created_at FROM invoices WHERE tenant_id = $1 AND order_id = $2 ORDER BY id`, [tenantId(), order.id]);
      const shipments = await db.query(`SELECT kind, status, awb, courier_name FROM shipments WHERE tenant_id = $1 AND order_id = $2 ORDER BY id`, [tenantId(), order.id]);
      const returns = await db.query(`SELECT id, status, resolution, created_at FROM returns WHERE tenant_id = $1 AND order_id = $2 ORDER BY id`, [tenantId(), order.id]);
      return { ...order, items, invoices, shipments, returns };
    },
  };

  return { shoppers, sessions, otps, addresses, orders, phoneHash };
}
