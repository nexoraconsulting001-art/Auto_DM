import { automationsApi } from './api.js';
import { createAutomationEngine, engineFor } from './engine.js';
import { inboxRepo } from './inbox.js';
import { automationsRepo } from './repo.js';
import { iceBreakersRepo, testersRepo } from './testers.js';

export { createAutomationEngine };

const RETENTION_EVERY_MS = 3_600_000;

/** PRD 6.1 to 6.5, 6.7 to 6.9: automations and their variants, the keyword matcher, testers, ice breakers and the owner inbox. */
export const automations = {
  name: 'automations',
  repos: (db) => ({ automations: automationsRepo(db), inbox: inboxRepo(db), testers: testersRepo(db), iceBreakers: iceBreakersRepo(db) }),
  api: automationsApi,

  /** The compliance worker calls this for every event that got past its rules. */
  onInboundEvent: (event, ctx) => engineFor(ctx).handle(event),

  jobs(ctx) {
    const engine = engineFor(ctx);
    let nextRetention = 0;
    return async function schedule() {
      const retention = Date.now() >= nextRetention;
      if (retention) nextRetention = Date.now() + RETENTION_EVERY_MS;
      await engine.housekeeping({ retention });
    };
  },
};
