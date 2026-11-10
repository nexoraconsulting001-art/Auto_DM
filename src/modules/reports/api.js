import { ApiError } from '../../contracts/api/index.js';
import { reportServices } from './services.js';

const notFound = () => {
  throw new ApiError('not_found');
};

/**
 * The seller routes of 7.9 and 7.13. Who may call each is in the contract (src/contracts/api/reports.js): readers for downloads and reports, managers
 * for schedules, the owner alone for outside addresses and API keys. Another business's id gets the same 404 as one that doesn't exist.
 */
export function reportsApi(ctx) {
  const on = () => reportServices(ctx);
  return {
    'downloads.list': ({ query, user }) => on().downloads.list(query, user),
    'downloads.create': ({ body, user }) => on().downloads.create(body, user),
    'downloads.get': ({ params, user }) => on().downloads.get(params.id, user),

    'reports.list': ({ query }) => on().runs.list(query),
    'reports.get': ({ params }) => on().runs.get(params.id),
    'reports.preferences': ({ user }) => on().preferences.view(user),
    'reports.updatePreferences': ({ body, user }) => on().preferences.update(user, body),
    'reports.unsubscribe': ({ body }) => on().preferences.unsubscribe(body),

    'scheduledReports.list': ({ query, user }) => on().scheduled.list(query, user),
    'scheduledReports.create': ({ body, user }) => on().scheduled.create(body, user),
    'scheduledReports.update': ({ params, body, user }) => on().scheduled.update(params.id, body, user),
    'scheduledReports.remove': async ({ params, user }) => (await on().scheduled.remove(params.id, user)) || notFound(),
    'scheduledReports.addRecipient': ({ params, body, user }) => on().scheduled.addRecipient(params.id, body, user),
    'scheduledReports.removeRecipient': async ({ params, user }) => (await on().scheduled.removeRecipient(params.id, user)) || notFound(),

    'apiKeys.list': ({ query }) => on().apiKeys.list(query),
    'apiKeys.create': ({ body, user }) => on().apiKeys.create(body, user),
    'apiKeys.revoke': async ({ params, user }) => (await on().apiKeys.revoke(params.id, user)) || notFound(),
  };
}
