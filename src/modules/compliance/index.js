import { notBuilt } from '../not-built.js';
import { complianceRepo } from './repo.js';

export { createCompliance } from './send.js';

/**
 * PRD 4, 6.1 to 6.4: the gate every send passes, webhook intake, the queue and its worker, budgets, caps, opt-outs, the
 * breaker and the kill switch. Intake registers POST /webhook in beforeTenant, which runs before the Phase 0 route in
 * src/server.js and so replaces it.
 */
export const compliance = {
  name: 'compliance',
  repos: (db) => ({ compliance: complianceRepo(db) }),
  api: () => notBuilt(
    'compliance.status', 'compliance.pause', 'compliance.resume', 'compliance.settings', 'compliance.updateSettings', 'compliance.activity', 'compliance.whyNoDm',
    'compliance.heldJobs', 'compliance.discardHeld', 'compliance.slowModeOverride', 'compliance.words', 'compliance.addWord', 'compliance.removeWord',
  ),
};
