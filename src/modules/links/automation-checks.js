import { ApiError } from '../../contracts/api/index.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { createLinkChecker, verifyLink } from './check.js';

/** The link check as automations see it: before going live, and daily while live (PRD 4.11). */

export const DAILY_QUEUE = 'links.daily_check';
export const DAILY_EVERY_MS = 5 * 60_000;
const DAILY_BATCH = 40; // sequential and at most about 6 s each, so one run ends inside the queue's lease
const DAY_MS = 24 * 3_600_000;
const CHECK_HISTORY = `interval '90 days'`;

const REFUSALS = Object.freeze({
  'link.redirect': 'That link redirects to another site. Use the address it ends up at.',
  'link.scheme': 'That link has to stay on https.',
  'link.check_failed': 'We couldn’t open that link. Check that it works and try again.',
});
const refusalFor = (reason) => REFUSALS[reason] ?? 'That link can’t be used in a DM.';

/** What linkProblem needs to know about this business. */
export async function linkContext(repos) {
  const settings = await repos.settings.getAll();
  return { whatsappNumber: settings.support_whatsapp, blockedHosts: await repos.automations.blockedHosts() };
}

export const checkerFor = ({ config, platform }) => createLinkChecker({ fetch: config?.linkCheckFetch, cache: platform?.cache });

const clockOf = (config) => () => new Date((config?.complianceNow ?? Date.now)());

/** Called by automations.setState before an automation goes to Test or Live. Throwing refuses it. */
export async function beforeAutomationLaunch(automation, ctx) {
  if (!automation.linkUrl) return;
  const { repos } = ctx;
  const verdict = await verifyLink(automation.linkUrl, await linkContext(repos), checkerFor(ctx));
  const at = clockOf(ctx.config)();
  if (verdict.unavailable) {
    log.warn('links.check_unavailable', { automation: automation.id });
    return;
  }
  if (verdict.ok) {
    await repos.links.linkPassed(automation.id, automation.linkUrl, verdict, at);
    return;
  }
  await repos.links.recordCheck({ automationId: automation.id, url: automation.linkUrl, verdict, at });
  const message = refusalFor(verdict.reason);
  throw new ApiError('validation_failed', message, { fields: { linkUrl: message }, reason: verdict.reason });
}

async function checkOne(row, ctx, check) {
  const { repos } = ctx;
  const verdict = await verifyLink(row.link_url, await linkContext(repos), check);
  const at = clockOf(ctx.config)();
  if (verdict.unavailable) {
    log.warn('links.check_unavailable', { automation: row.id });
    return;
  }
  if (verdict.ok) {
    await repos.links.linkPassed(row.id, row.link_url, verdict, at);
    return;
  }
  if (!(await repos.links.pauseForFailedLink(row.id, row.link_url, verdict, at))) return;
  await repos.compliance.record({ channel: null, kind: 'link_check', decision: 'failed', reason: verdict.reason, automationId: row.id, details: { httpStatus: verdict.httpStatus }, at });
  await repos.alerts.raise({
    kind: verdict.reason, severity: 'warning', target: String(row.id),
    message: `The link in your automation “${row.name}” stopped working, so the automation is paused. Fix the link, then turn it back on.`,
    dedupeKey: `${verdict.reason}:${row.id}:${Math.floor(+at / DAY_MS)}`,
  });
}

/**
 * Stamps each due automation first, so two workers can't take the same one and a crash costs a day rather than a loop. A live automation
 * is due a day after its last check, or as soon as its link has been edited.
 */
export async function runDueChecks(ctx) {
  const check = checkerFor(ctx);
  const due = await ctx.db.platform.query(
    `UPDATE automations a SET link_checked_at = now()
     FROM (SELECT id FROM automations
           WHERE state = 'live' AND link_url <> ''
             AND (link_checked_at IS NULL OR link_checked_at < now() - interval '24 hours' OR (link_status = 'unchecked' AND link_checked_at < updated_at))
           ORDER BY link_checked_at NULLS FIRST LIMIT $1 FOR UPDATE SKIP LOCKED) d
     WHERE a.id = d.id RETURNING a.tenant_id, a.id, a.name, a.link_url`,
    [DAILY_BATCH],
  );
  for (const row of due) {
    try {
      await withTenant(row.tenant_id, () => checkOne(row, ctx, check));
    } catch (err) {
      reportError(err, { msg: 'links.daily_check_failed', automation: row.id });
    }
  }
  await ctx.db.platform.query(`DELETE FROM link_checks WHERE checked_at < now() - ${CHECK_HISTORY}`);
}
