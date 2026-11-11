import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { opsAlert } from './alerts.js';
import { cleanText, failureFields, failureOf, stateName, tenDigits } from './util.js';

/**
 * How one business ships (PRD 9.10): Bhava's own Shiprocket account by default ("managed", one pickup location per seller on
 * the master account), or the seller's own Shiprocket API user ("own"). The mode applies to new shipments only: each
 * shipment keeps the mode it was made with.
 *
 *   get()                      what the console's shipping settings screen shows; never the password
 *   update(patch, actor)       audited. A complete pickup address is registered with the courier account in use before it
 *                              is saved, so the label shows this seller as shipper (S-77); a login the seller's own account
 *                              refuses is refused here and nothing is saved
 *   row(q?)                    the settings row, or the defaults
 *   ensurePickup()             registers the pickup address with the account in use if it isn't yet; -> the row
 *   courierFor(mode, row?)     the Shiprocket client for that account: managed is the master account, own the seller's
 *   retryPickups()             the worker's sweep for registrations that failed for a passing reason
 *
 * A pickup location is registered under a fresh nickname each time the address or the account changes, so a retry after an
 * answer that was lost never collides with the first try. A nickname never names the platform: the label shows it.
 */
const BLANK = Object.freeze({
  mode: 'managed', pickup_location: '', pickup_name: '', pickup_phone: '', pickup_line1: '', pickup_line2: '', pickup_city: '',
  pickup_state_code: '', pickup_pincode: '', pickup_registered: false, own_email: '', own_password_enc: '', charge_billing: 'payout', updated_at: null,
});

const ADDRESS = Object.freeze({
  pickupName: 'pickup_name', pickupPhone: 'pickup_phone', pickupLine1: 'pickup_line1', pickupLine2: 'pickup_line2', pickupCity: 'pickup_city',
  pickupStateCode: 'pickup_state_code', pickupPincode: 'pickup_pincode',
});
const MAX = Object.freeze({ pickup_name: 80, pickup_phone: 16, pickup_line1: 200, pickup_line2: 200, pickup_city: 60, pickup_state_code: 2, pickup_pincode: 6 });

export const addressComplete = (r) => Boolean(r.pickup_name && r.pickup_phone && r.pickup_line1 && r.pickup_city && r.pickup_state_code && r.pickup_pincode);
export const pickupReady = (r) => Boolean(r.pickup_registered && r.pickup_location);

const toSettings = (r) => ({
  mode: r.mode,
  pickupName: r.pickup_name,
  pickupPhone: r.pickup_phone,
  pickupLine1: r.pickup_line1,
  pickupLine2: r.pickup_line2,
  pickupCity: r.pickup_city,
  pickupStateCode: r.pickup_state_code,
  pickupPincode: r.pickup_pincode,
  pickupRegistered: pickupReady(r),
  ownEmail: r.own_email,
  ownPasswordSet: Boolean(r.own_password_enc),
  chargeBilling: r.charge_billing,
});

/** A fresh nickname for a pickup location: this business's id and a random part. Never the platform's name. */
const pickupCode = () => `S${tenantId()}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`.slice(0, 36);

export function createSettings(ctx) {
  const { db, providers, config = {} } = ctx;
  const secrets = ctx.platform?.secrets;
  const platformDb = db.platform ?? db;
  const memo = new Map(); // tenant -> { row, until }: the serviceability check runs inside checkout's transaction (see serviceability.js)
  const forget = () => memo.delete(tenantId());

  async function row(q = db) {
    const [found] = await q.query('SELECT * FROM shipping_settings WHERE tenant_id = $1', [tenantId()]);
    return found ?? { ...BLANK, tenant_id: tenantId(), missing: true };
  }

  /** The row from this process's memory when it was read in the last minute. */
  async function cachedRow() {
    const held = memo.get(tenantId());
    if (held && held.until > Date.now()) return held.row;
    const fresh = await row();
    memo.set(tenantId(), { row: fresh, until: Date.now() + 60_000 });
    return fresh;
  }

  const ownLogin = (r) => {
    if (!r.own_email || !r.own_password_enc) return null;
    try {
      return { email: r.own_email, password: secrets.decrypt(r.own_password_enc) };
    } catch (err) {
      reportError(err, { msg: 'shipping.own_password_unreadable' });
      return null;
    }
  };

  /** The Shiprocket client for an account. Own mode with no readable login throws a refusal the seller can act on. */
  function courierFor(mode, r) {
    if (mode !== 'own') {
      if (!config.shiprocketEmail || !config.shiprocketPassword) throw new ApiError('conflict', 'Shipping isn’t available just now. Please contact support.');
      return providers.shiprocket.forAccount(null);
    }
    const login = ownLogin(r);
    if (!login) throw new ApiError('conflict', 'Add your Shiprocket API email and password in Shipping settings.');
    return providers.shiprocket.forAccount(login);
  }

  /**
   * Registers `r`'s pickup address with the account its mode names. -> { code } | { failed: 'auth' | 'refused' | 'retry' }.
   * Changes nothing here: the caller saves the answer.
   */
  async function register(r, mode = r.mode) {
    const code = pickupCode();
    let courier;
    try {
      courier = courierFor(mode, r);
    } catch {
      return { failed: 'auth' };
    }
    try {
      await courier.addPickupLocation({
        code, name: r.pickup_name, phone: r.pickup_phone, email: mode === 'own' ? r.own_email : '', line1: r.pickup_line1, line2: r.pickup_line2,
        city: r.pickup_city, state: stateName(r.pickup_state_code), pincode: r.pickup_pincode,
      });
      log.info('shipping.pickup_registered', { tenantId: tenantId(), mode });
      return { code };
    } catch (err) {
      const failure = failureOf(err);
      log.warn('shipping.pickup_failed', { tenantId: tenantId(), mode, failure, ...failureFields(err) });
      if (failure === 'auth' && mode === 'managed') {
        await opsAlert(platformDb, { tenantId: tenantId(), kind: 'shipping.master_login', message: 'The master courier account refused its login while adding a pickup address.', target: 'shipping', dedupeKey: 'shipping-master-login' });
      }
      if (!(err?.name === 'ProviderError')) reportError(err, { msg: 'shipping.pickup_error' });
      return { failed: failure === 'unknown' ? 'retry' : failure };
    }
  }

  async function saveRegistration(at, code) {
    // Only if nothing changed the address or the account meanwhile: updated_at is the version.
    const [saved] = await db.query(
      `UPDATE shipping_settings SET pickup_location = $3, pickup_registered = true WHERE tenant_id = $1 AND updated_at = $2 RETURNING *`,
      [tenantId(), at, code],
    );
    forget();
    return saved ?? null;
  }

  return {
    row,
    cachedRow,
    courierFor,
    forget,

    async get() {
      return toSettings(await row());
    },

    async update(patch, actor) {
      const before = await row();
      const next = { ...before };
      const fields = {};
      for (const [key, column] of Object.entries(ADDRESS)) {
        if (patch[key] === undefined) continue;
        next[column] = cleanText(patch[key], MAX[column]);
      }
      if (patch.pickupPhone !== undefined) {
        const phone = tenDigits(patch.pickupPhone);
        if (!phone) fields.pickupPhone = 'Enter a 10-digit phone number';
        else next.pickup_phone = phone;
      }
      if (patch.pickupStateCode !== undefined && !stateName(next.pickup_state_code)) fields.pickupStateCode = 'Pick a state';
      if (patch.mode !== undefined) next.mode = patch.mode;
      if (patch.chargeBilling !== undefined) next.charge_billing = patch.chargeBilling;
      if (patch.ownEmail !== undefined) next.own_email = cleanText(patch.ownEmail, 254).toLowerCase();
      let newPassword = null;
      if (patch.ownPassword !== undefined) {
        if (/\u0000/.test(patch.ownPassword)) fields.ownPassword = 'Contains a character that isn’t allowed';
        else newPassword = patch.ownPassword;
      }
      if (Object.keys(fields).length) throw new ApiError('validation_failed', Object.values(fields)[0], { fields });
      if (newPassword !== null) {
        if (!secrets?.configured) throw new ApiError('conflict', 'Your own courier account can’t be connected yet. Please contact support.');
        next.own_password_enc = secrets.encrypt(newPassword);
      }
      if (patch.ownEmail === '') next.own_password_enc = newPassword !== null ? next.own_password_enc : '';
      if (next.mode === 'own' && (!next.own_email || !next.own_password_enc)) {
        throw new ApiError('validation_failed', 'Enter your Shiprocket API email and password', { fields: { ownEmail: 'Enter your Shiprocket API email', ownPassword: 'Enter its password' } });
      }

      const addressChanged = Object.values(ADDRESS).some((c) => next[c] !== before[c]);
      const accountChanged = next.mode !== before.mode || (next.mode === 'own' && (next.own_email !== before.own_email || newPassword !== null));
      if (addressChanged || accountChanged) {
        next.pickup_location = '';
        next.pickup_registered = false;
      }

      // Register before saving, so a login the seller's own account refuses is refused here with nothing saved.
      if (addressComplete(next) && !pickupReady(next)) {
        const done = await register(next);
        if (done.code) {
          next.pickup_location = done.code;
          next.pickup_registered = true;
        } else if (done.failed === 'auth' && next.mode === 'own') {
          throw new ApiError('validation_failed', 'Shiprocket didn’t accept this email and password. Use the API user from your Shiprocket settings.', { fields: { ownPassword: 'Shiprocket didn’t accept this login' } });
        } else if (done.failed === 'refused') {
          throw new ApiError('validation_failed', 'The courier didn’t accept this pickup address. Check the PIN code, city and phone number.', { fields: { pickupPincode: 'Check this address' } });
        }
        // Otherwise it is saved unregistered, and the worker tries again shortly.
      }

      const saved = await db.tx(async (t) => {
        const [out] = await t.query(
          `INSERT INTO shipping_settings (tenant_id, mode, pickup_location, pickup_name, pickup_phone, pickup_line1, pickup_line2, pickup_city, pickup_state_code,
             pickup_pincode, pickup_registered, own_email, own_password_enc, charge_billing, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, date_trunc('milliseconds', clock_timestamp()))
           ON CONFLICT (tenant_id) DO UPDATE SET mode = EXCLUDED.mode, pickup_location = EXCLUDED.pickup_location, pickup_name = EXCLUDED.pickup_name,
             pickup_phone = EXCLUDED.pickup_phone, pickup_line1 = EXCLUDED.pickup_line1, pickup_line2 = EXCLUDED.pickup_line2, pickup_city = EXCLUDED.pickup_city,
             pickup_state_code = EXCLUDED.pickup_state_code, pickup_pincode = EXCLUDED.pickup_pincode, pickup_registered = EXCLUDED.pickup_registered,
             own_email = EXCLUDED.own_email, own_password_enc = EXCLUDED.own_password_enc, charge_billing = EXCLUDED.charge_billing, updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [tenantId(), next.mode, next.pickup_location, next.pickup_name, next.pickup_phone, next.pickup_line1, next.pickup_line2, next.pickup_city, next.pickup_state_code,
            next.pickup_pincode, next.pickup_registered, next.own_email, next.own_password_enc, next.charge_billing],
        );
        const changed = [...Object.keys(ADDRESS).filter((k) => next[ADDRESS[k]] !== before[ADDRESS[k]]), ...(next.mode !== before.mode ? ['mode'] : []),
          ...(next.charge_billing !== before.charge_billing ? ['chargeBilling'] : []), ...(next.own_email !== before.own_email ? ['ownEmail'] : []), ...(newPassword !== null ? ['ownPassword'] : [])];
        // The names of what changed and the mode: never the address, the phone, the email or the password.
        await writeAudit(t, { actor, action: 'shipping.settings_updated', target: 'shipping_settings', details: { changed, mode: next.mode, pickupRegistered: out.pickup_registered } });
        return out;
      });
      forget();
      log.info('shipping.settings_saved', { tenantId: tenantId(), mode: saved.mode, registered: saved.pickup_registered });
      return toSettings(saved);
    },

    async ensurePickup() {
      const current = await row();
      if (pickupReady(current) || !addressComplete(current) || current.missing) return current;
      const done = await register(current);
      if (!done.code) return current;
      return (await saveRegistration(current.updated_at, done.code)) ?? row();
    },

    /** Businesses whose pickup address is complete but not yet registered, tried again a few at a time for two days after the save. */
    async retryPickups({ limit = 20 } = {}, each) {
      const rows = await platformDb.query(
        `SELECT tenant_id FROM shipping_settings WHERE NOT pickup_registered AND pickup_name <> '' AND pickup_line1 <> '' AND pickup_pincode <> ''
           AND pickup_city <> '' AND pickup_state_code <> '' AND pickup_phone <> ''
           AND updated_at BETWEEN now() - interval '2 days' AND now() - interval '1 minute' ORDER BY updated_at LIMIT $1`,
        [limit],
      );
      for (const r of rows) await each(r.tenant_id);
      return rows.length;
    },
  };
}
