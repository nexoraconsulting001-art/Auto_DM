import { PLAYBOOKS } from '../../contracts/apps.js';
import { reportError } from '../../platform/log.js';
import { mountConsoleRoute } from './console.js';
import { appSubmissionsFor } from './service.js';

export { appSubmissionsFor, cleanGuideline } from './service.js';
export { presubmitBuild, serverFacts, releaseFactsOf } from './presubmit.js';

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
 *
 * The gate's checks are tools/presubmit/checks.mjs, the same the command runs against a built app; the server reads what the
 * binary holds from release-facts.json (presubmit.js). Each playbook is docs/playbooks/<code>.md. submit() moves the build to
 * 'submitted' through appBuildsFor(ctx).markStatus when app-builds has it, else with the same guarded UPDATE.
 */
const API = ['appPublishing.submissions'];
const PLATFORM = ['platform.appSubmissions', 'platform.setSubmissionState', 'platform.appRejections', 'platform.appPlaybooks', 'platform.appReviewTasks', 'platform.resolveAppReviewTask'];
const POLL = 'app-submissions.poll';

export const appSubmissions = {
  name: 'app-submissions',
  owns: {
    migrations: ['603_app_submissions.sql'],
    tables: ['app_submissions', 'app_submission_history', 'app_rejections', 'app_review_tasks', 'presubmit_runs'],
    api: API,
    store: [],
    platform: PLATFORM,
    jobs: [POLL],
  },
  api: (ctx) => ({
    'appPublishing.submissions': async () => ({ items: await appSubmissionsFor(ctx).list() }),
  }),
  platformRoutes(router, ctx) {
    const service = () => appSubmissionsFor(ctx).console;
    mountConsoleRoute(router, 'platform.appSubmissions', ({ query }) => service().list(query));
    mountConsoleRoute(router, 'platform.setSubmissionState', ({ params, body, actor }) => service().move(params.id, body, actor));
    mountConsoleRoute(router, 'platform.appRejections', ({ query }) => service().rejections(query));
    mountConsoleRoute(router, 'platform.appPlaybooks', () => ({ items: Object.values(PLAYBOOKS).map((p) => ({ ...p })) }));
    mountConsoleRoute(router, 'platform.appReviewTasks', ({ query }) => service().tasks(query));
    mountConsoleRoute(router, 'platform.resolveAppReviewTask', ({ params, body, actor }) => service().resolveTask(params.id, body.resolution, actor));
  },
  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(POLL, () => appSubmissionsFor(ctx).poll().catch((err) => reportError(err, { msg: 'app_submissions.poll_failed' })));
    return async function schedule() {
      await queue.every(POLL, ctx.config.storeReviewPollMs || 900_000);
    };
  },
};
