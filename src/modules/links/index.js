import { linksApi } from './api.js';
import { DAILY_EVERY_MS, DAILY_QUEUE, beforeAutomationLaunch, runDueChecks } from './automation-checks.js';
import { linksRepo } from './repo.js';
import { onTap } from './taps.js';

/** PRD 4.11, 6.6, 6.13: direct links, UTM tags and per-reel measurement ids, link checks, and the two-tap "Send me the link" flow. */
export const links = {
  name: 'links',
  repos: (db) => ({ links: linksRepo(db) }),
  api: linksApi,

  /** The compliance worker calls this for every event that got past its rules. */
  onInboundEvent: onTap,

  beforeAutomationLaunch,

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(DAILY_QUEUE, () => runDueChecks(ctx));
    return async function schedule() {
      await queue.every(DAILY_QUEUE, DAILY_EVERY_MS);
    };
  },
};
