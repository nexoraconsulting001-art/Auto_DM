import { AUTH_LIMITS, newToken, sameSecret, tokenHash } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { dropPushDevices, revokeFamilies } from './tokens.js';
import { limit, platformOf } from './shared.js';

/**
 * Settings > Devices (PRD 10.2, 10.3): the devices a person is signed in on. A device row is written at each sign-in
 * that names one. Revoking a device ends every family on it at once, on every business (P-08), and forgets its re-auth
 * secret. That secret (F-110, P-68) is made by auth.enableDeviceUnlock, returned once and kept by the app behind
 * fingerprint or face unlock; the server holds only its hash, and it only ever re-auths a session the device already
 * has. It never signs anyone in.
 */
export function devicesService(ctx) {
  const db = () => platformOf(ctx.db);

  /** Records the device at a sign-in. Returns whether it already holds a re-auth secret. */
  async function seen(personId, device) {
    if (!device) return false;
    const [row] = await db().query(
      `INSERT INTO auth_devices (person_id, device_id, name, platform, app, app_version) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (person_id, device_id) DO UPDATE SET name = EXCLUDED.name, platform = EXCLUDED.platform, app = EXCLUDED.app,
         app_version = EXCLUDED.app_version, last_seen_at = now(), revoked_at = NULL
       RETURNING reauth_secret_hash IS NOT NULL AS unlock`,
      [personId, device.id, device.name ?? '', device.platform, device.app ?? 'owner', device.appVersion ?? ''],
    );
    return Boolean(row?.unlock);
  }

  async function list({ user, req }) {
    if (!user.person_id) return { devices: [] };
    const rows = await db().query(
      `SELECT id, device_id, name, platform, app, app_version, last_seen_at, reauth_secret_hash IS NOT NULL AS unlock
       FROM auth_devices WHERE person_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC, id DESC`,
      [user.person_id],
    );
    const current = req.session?.deviceId ?? null;
    return {
      devices: rows.map((d) => ({
        id: Number(d.id), name: d.name, platform: d.platform, app: d.app, appVersion: d.app_version, lastSeenAt: d.last_seen_at,
        current: current !== null && d.device_id === current, deviceUnlock: d.unlock,
      })),
    };
  }

  async function revoke({ params, user }) {
    if (!user.person_id) throw new ApiError('not_found');
    const ended = await db().tx(async (t) => {
      const [device] = await t.query(
        'UPDATE auth_devices SET revoked_at = now(), reauth_secret_hash = NULL WHERE id = $1 AND person_id = $2 AND revoked_at IS NULL RETURNING device_id',
        [params.id, user.person_id],
      );
      if (!device) return null;
      const families = await revokeFamilies(t, { personId: user.person_id, deviceId: device.device_id, reason: 'device_revoked' });
      await dropPushDevices(t, { personId: user.person_id, deviceId: device.device_id, reason: 'device_revoked' });
      return families.length;
    });
    if (ended === null) throw new ApiError('not_found');
    log.info('accounts.device_revoked', { personId: user.person_id, device: params.id, families: ended });
  }

  async function enableUnlock({ user, req }) {
    const deviceId = req.session?.deviceId ?? null;
    if (!user.person_id || !deviceId) throw new ApiError('conflict', 'Fingerprint or face unlock is turned on in the app, on the phone itself.');
    const secret = newToken(32);
    const [row] = await db().query(
      'UPDATE auth_devices SET reauth_secret_hash = $3 WHERE person_id = $1 AND device_id = $2 AND revoked_at IS NULL RETURNING id',
      [user.person_id, deviceId, tokenHash(secret)],
    );
    if (!row) throw new ApiError('conflict', 'Fingerprint or face unlock is turned on in the app, on the phone itself.');
    log.info('accounts.device_unlock_on', { personId: user.person_id, device: Number(row.id) });
    return { deviceSecret: secret };
  }

  /** True when `secret` is this device's re-auth secret. Tries are limited per person and device. */
  async function secretMatches({ personId, deviceId, secret }) {
    if (!personId || !deviceId) return false;
    await limit(ctx.platform, AUTH_LIMITS.deviceSecretTries, `${personId}:${deviceId}`);
    const [row] = await db().query(
      'SELECT reauth_secret_hash FROM auth_devices WHERE person_id = $1 AND device_id = $2 AND revoked_at IS NULL',
      [personId, deviceId],
    );
    const stored = row?.reauth_secret_hash ?? '';
    const given = typeof secret === 'string' && secret ? tokenHash(secret) : '';
    return Boolean(stored) && Boolean(given) && sameSecret(given, stored);
  }

  return { seen, list, revoke, enableUnlock, secretMatches };
}
