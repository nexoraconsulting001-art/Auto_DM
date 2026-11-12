import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { notBuilt } from '../not-built.js';

/**
 * The meters (PRD 5.12): DMs, WhatsApp messages and AI units per business and month. Track usage. Contract only so far.
 *
 * Owns usage_events and usage_months (701). What the track builds here:
 *
 * - setup(ctx), in the app and in the worker: ctx.compliance.onAccepted(event => insert one usage_events row with
 *   event.key as its idempotency key, ON CONFLICT (tenant_id, idempotency_key) DO NOTHING) and
 *   ctx.compliance.useQuota({ hasDmsLeft }). The database sets the month and adds the row to usage_months, so a send is
 *   counted once however often it is reported. Test sends and previews never reach the listener (F-82).
 * - hasDmsLeft: meterOf({ used, included, packUnits }) from this month's row, with included from
 *   repos.entitlements.limit('dms.monthly') and packUnits from the running dm_pack items. Asked on every send, so keep it to
 *   one indexed read.
 * - The alerts at 80% and 100% of included DMs plus packs, once each (alertsDue, the two marks on usage_months), through
 *   ctx.notify with the counts and the pack option (F-86); and at 100% the upgrade prompt (F-112).
 * - ctx.compliance.releaseDmLimit() inside the business whenever its allowance grows: a pack bought, a plan upgraded, the
 *   month turned.
 * - billing.usage: the live meter for the console and the owner app.
 * - WhatsApp messages and AI units with their cost, which billing turns into pass-through lines with counts (F-114).
 */
const API = BILLING_ROUTE_OWNERS.usage;

export const usage = {
  name: 'usage',
  owns: { migrations: [], tables: ['usage_events', 'usage_months'], api: API, store: [], platform: [], jobs: ['usage.alerts', 'usage.month_reset'] },
  api: () => notBuilt(...API),
};
