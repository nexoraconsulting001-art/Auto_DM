import { DEVICE_ID, tokenHash } from '../../contracts/accounts.js';
import { PUSH_PLATFORMS, PUSH_TOKEN, PUSH_TOKEN_GONE } from '../../contracts/notifications.js';
import { log } from '../../platform/log.js';

/**
 * Where a person's owner app can be pushed to (push_devices, migration 521). Platform-only: every call here runs on
 * db.platform, because one APNs key and one FCM project serve every business and a device belongs to a person, not to a
 * business. Which business a push is about is decided per event, from users.person_id.
 *
 * A device can be pushed to only while it is still signed in: its row is not deleted, its person is not deleted, its
 * sign-in on that device (a token family of kind user) is not revoked, and Settings > Devices has not revoked it
 * (auth_devices). Anything else is deleted the next time it would have been used, with the reason, so a revoked
 * device or a person who signed out gets nothing more even if nobody told this module.
 *
 * A token the provider called unregistered or invalid stays deleted: registering it again stores nothing, so it is never
 * tried again (P-23). The app gets a new token from FCM or APNs and registers that one.
 */
export const DEVICE_REASONS = Object.freeze(['unregistered', 'invalid_token', 'signed_out', 'device_revoked', 'account_deleted']);
const MAX_DEVICES = 10;
const LOCK_SPACE = 52150;

/** The rows of push_devices that can no longer be pushed to, as a condition on `d`. */
const GONE_CONDITION = `(
  p.deleted_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM auth_devices a WHERE a.person_id = d.person_id AND a.device_id = d.device_id AND a.revoked_at IS NOT NULL)
  OR NOT EXISTS (SELECT 1 FROM token_families f WHERE f.subject_kind = 'user' AND f.person_id = d.person_id AND f.device_id = d.device_id AND f.revoked_at IS NULL)
)`;
const GONE_REASON = `CASE
  WHEN p.deleted_at IS NOT NULL THEN 'account_deleted'
  WHEN EXISTS (SELECT 1 FROM auth_devices a WHERE a.person_id = d.person_id AND a.device_id = d.device_id AND a.revoked_at IS NOT NULL) THEN 'device_revoked'
  ELSE COALESCE((SELECT CASE f.revoke_reason WHEN 'account_deleted' THEN 'account_deleted' WHEN 'device_revoked' THEN 'device_revoked' ELSE 'signed_out' END
                 FROM token_families f WHERE f.subject_kind = 'user' AND f.person_id = d.person_id AND f.device_id = d.device_id
                 ORDER BY f.revoked_at DESC NULLS LAST LIMIT 1), 'signed_out')
END`;

export function createDevices({ platformDb, secrets }) {
  /** Registers or replaces a device's token. A token seen before moves here; a device seen before gets the new token. */
  async function register({ personId, deviceId, platform, token, appVersion = '' }) {
    if (!Number.isSafeInteger(personId) || personId <= 0) throw new Error('A push device belongs to a person');
    if (!DEVICE_ID.test(String(deviceId)) || !PUSH_PLATFORMS.includes(platform) || !PUSH_TOKEN.test(String(token))) throw new Error('Not a push device');
    const hash = tokenHash(token);
    const encrypted = secrets.encrypt(token);
    return platformDb.tx(async (t) => {
      // One registration of a token at a time, so a token that moves between devices is never on two rows.
      await t.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_SPACE, `token:${hash}`]);
      await t.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_SPACE + 1, `device:${personId}:${deviceId}`]);
      const [known] = await t.query('SELECT id, person_id, device_id, deleted_at, delete_reason FROM push_devices WHERE token_hash = $1 FOR UPDATE', [hash]);
      if (known?.deleted_at && PUSH_TOKEN_GONE.includes(known.delete_reason)) {
        log.info('push.token_not_revived', { personId, reason: known.delete_reason });
        return { stored: false, reason: known.delete_reason };
      }
      if (known && !(Number(known.person_id) === personId && known.device_id === deviceId)) await t.query('DELETE FROM push_devices WHERE id = $1', [known.id]);
      const [row] = await t.query(
        `INSERT INTO push_devices (person_id, device_id, platform, token_enc, token_hash, app_version) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (person_id, device_id) DO UPDATE SET platform = EXCLUDED.platform, token_enc = EXCLUDED.token_enc, token_hash = EXCLUDED.token_hash,
           app_version = EXCLUDED.app_version, created_at = now(), last_ok_at = NULL, deleted_at = NULL, delete_reason = ''
         RETURNING id`,
        [personId, deviceId, platform, encrypted, hash, String(appVersion ?? '').slice(0, 20)],
      );
      log.info('push.device_registered', { personId, pushDeviceId: Number(row.id), platform });
      return { stored: true, id: Number(row.id) };
    });
  }

  /** Signing out, revoking a device, deleting an account: the row (or every row of the person) gets nothing more. */
  async function forget({ personId, deviceId = null, reason = 'signed_out' }) {
    if (!DEVICE_REASONS.includes(reason)) throw new Error(`A device is forgotten for one of ${DEVICE_REASONS.join(', ')}`);
    const rows = await platformDb.query(
      `UPDATE push_devices SET deleted_at = now(), token_enc = NULL, delete_reason = $3
       WHERE person_id = $1 AND ($2::text IS NULL OR device_id = $2::text) AND deleted_at IS NULL RETURNING id`,
      [personId, deviceId, reason],
    );
    if (rows.length) log.info('push.device_forgotten', { personId, devices: rows.length, reason });
    return rows.length;
  }

  /** The provider said the token is gone: deleted then and there, the token wiped, never tried again. */
  async function markGone(id, reason) {
    await platformDb.query(`UPDATE push_devices SET deleted_at = now(), token_enc = NULL, delete_reason = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, reason]);
    log.info('push.token_deleted', { pushDeviceId: Number(id), reason });
  }

  async function markOk(ids) {
    if (ids.length) await platformDb.query('UPDATE push_devices SET last_ok_at = now() WHERE id = ANY($1::bigint[])', [ids]);
  }

  /** How many devices each person can be pushed to right now (read only: handing out uses this). */
  async function counts(q, personIds) {
    const ids = [...new Set(personIds.filter((id) => id !== null && id !== undefined).map(Number))];
    if (!ids.length) return new Map();
    const rows = await q.query(
      `SELECT d.person_id, count(*)::int AS n FROM push_devices d JOIN people p ON p.id = d.person_id
       WHERE d.person_id = ANY($1::bigint[]) AND d.deleted_at IS NULL AND NOT ${GONE_CONDITION} GROUP BY d.person_id`,
      [ids],
    );
    return new Map(rows.map((r) => [Number(r.person_id), r.n]));
  }

  /**
   * The devices to push to for one person, newest first, with their tokens decrypted. Rows that can no longer be pushed
   * to are deleted here first, with the reason. A token that cannot be decrypted (a key that is gone) is left out.
   */
  async function forPerson(personId) {
    if (!personId) return [];
    const gone = await platformDb.query(
      `UPDATE push_devices d SET deleted_at = now(), token_enc = NULL, delete_reason = ${GONE_REASON}
       FROM people p WHERE p.id = d.person_id AND d.person_id = $1 AND d.deleted_at IS NULL AND ${GONE_CONDITION} RETURNING d.id, d.delete_reason`,
      [personId],
    );
    for (const row of gone) log.info('push.device_dropped', { pushDeviceId: Number(row.id), reason: row.delete_reason });
    const rows = await platformDb.query(
      'SELECT id, platform, token_enc FROM push_devices WHERE person_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT $2',
      [personId, MAX_DEVICES],
    );
    const devices = [];
    for (const row of rows) {
      try {
        devices.push({ id: Number(row.id), platform: row.platform, token: secrets.decrypt(row.token_enc) });
      } catch {
        log.warn('push.token_unreadable', { pushDeviceId: Number(row.id) });
      }
    }
    return devices;
  }

  return { register, forget, markGone, markOk, counts, forPerson };
}
