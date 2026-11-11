import { reportError } from '../../platform/log.js';
import { alertsRepo } from '../alerts/index.js';

/**
 * Telling people about shipping problems. Messages are Bhava's own words to the seller or to our team: order numbers and ids,
 * never a shopper's name, phone number or address. Each has a dedupe key, so a job that repeats raises it once.
 */

/** An alert for the current business's owner. Never throws: a failed alert never undoes the work it reports. */
export async function ownerAlert(db, alert) {
  try {
    await alertsRepo(db).raise({ severity: 'warning', ...alert, audience: 'owner' });
  } catch (err) {
    reportError(err, { msg: 'shipping.alert_failed', kind: alert.kind });
  }
}

/** An alert for our team, from the platform path, where there may be no business. Deduplicated by key either way. */
export async function opsAlert(platformDb, { tenantId = null, kind, message, severity = 'critical', target = '', dedupeKey }) {
  try {
    await platformDb.query(
      `INSERT INTO alerts (tenant_id, audience, kind, severity, message, target, dedupe_key)
       SELECT $1::integer, 'ops', $2, $3, $4, $5, $6::text
       WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE tenant_id IS NOT DISTINCT FROM $1::integer AND audience = 'ops' AND dedupe_key = $6::text)
       ON CONFLICT DO NOTHING`,
      [tenantId, kind, severity, message, target, dedupeKey],
    );
  } catch (err) {
    reportError(err, { msg: 'shipping.ops_alert_failed', kind });
  }
}
