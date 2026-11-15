import { FEEDBACK_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { platformNotBuilt } from '../not-built.js';

const PLATFORM = FEEDBACK_PLATFORM_OWNERS.feedback;

/**
 * Feedback from showcase sessions (Phase 8, Q-13): logged against the business that gave it, tracked from `new` to
 * `planned` and then `fixed` (with what fixed it) or `declined`, and listed in the Platform Console. The table is
 * feedback_items (migration 810): the platform's, out of reach of business code, so every query here is on db.platform.
 *
 *   platform.feedback         GET   /feedback                 every item, newest first; filter by business and state
 *   platform.createFeedback   POST  /tenants/:id/feedback     who said it, where in the product, the words, a severity
 *   platform.updateFeedback   PATCH /feedback/:id             state, severity, fixedIn; `fixed` needs fixedIn, and only `fixed` has it
 *
 * Each route answers 501 until the feedback track builds it (mountRoute from ../platform-console/mount.js). Creating and
 * updating are audited with the operator. The screen is console/src/platform/features/feedback.
 */
export const feedback = {
  name: 'feedback',
  owns: { migrations: ['810_feedback.sql'], tables: ['feedback_items'], api: [], store: [], platform: PLATFORM, jobs: [] },
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};
