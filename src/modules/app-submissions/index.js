import { notBuilt, platformNotBuilt } from '../not-built.js';

/**
 * Store review (PRD 10.14): where each brand's app stands on each store, rejections and their playbooks, the review tasks our
 * team owns, and the pre-submit gate. Track store-release. Owns 603: app_submissions, app_submission_history, app_rejections,
 * app_review_tasks and presubmit_runs. The triggers there are the second lock behind change().
 *
 *   appSubmissionsFor(ctx) -> { list(), get(platform), change(t, platform, to, { actor, reason?, set?, ifAllowed? }),
 *                               recordRejection(t, platform, { guideline, message, providerKey, appVersion?, buildNumber? })
 *                                 -> { rejection, taskOpened },
 *                               recordPresubmit(buildId, { platform, checks, toolVersion }) -> { passed },
 *                               submit(buildId, { actor }) -> AppSubmission, poll() }   made once per ctx (a WeakMap)
 *
 * change() is the only code that writes app_submissions.state, along APP_TRANSITIONS; ifAllowed skips a late or repeated store
 * answer instead of throwing. submit() runs the pre-submit gate (PRESUBMIT_CHECKS), then ctx.eas.submit with
 * storeAccessFor(ctx).credentials(platform). Two rejections on one guideline open a review task (the database does it) and block
 * resubmission until our team resolves it. Live, rejected and a failed build reach the owner through ctx.notify only (app.live,
 * app.rejected, app.build_failed).
 *
 * Schedule app-submissions.poll (config.storeReviewPollMs): reads both stores through ctx.appStores.
 */
const API = ['appPublishing.submissions'];
const PLATFORM = ['platform.appSubmissions', 'platform.setSubmissionState', 'platform.appRejections', 'platform.appPlaybooks', 'platform.appReviewTasks', 'platform.resolveAppReviewTask'];

export const appSubmissions = {
  name: 'app-submissions',
  owns: {
    migrations: ['603_app_submissions.sql'],
    tables: ['app_submissions', 'app_submission_history', 'app_rejections', 'app_review_tasks', 'presubmit_runs'],
    api: API,
    store: [],
    platform: PLATFORM,
    jobs: ['app-submissions.poll'],
  },
  api: () => notBuilt(...API),
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};
