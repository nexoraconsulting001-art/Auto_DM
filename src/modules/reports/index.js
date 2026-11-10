import { notBuilt } from '../not-built.js';

/** PRD 7.9, 7.11 to 7.13: Explore, saved views, custom funnels and cohorts, summary downloads, weekly, monthly and scheduled reports, and the reporting API. */
export const reports = {
  name: 'reports',
  api: () => notBuilt(
    'explore.catalog', 'explore.query',
    'savedViews.list', 'savedViews.create', 'savedViews.get', 'savedViews.update', 'savedViews.remove', 'savedViews.pin', 'savedViews.unpin',
    'dashboard.cards',
    'funnels.list', 'funnels.create', 'funnels.get', 'funnels.update', 'funnels.remove', 'funnels.results',
    'cohorts.get',
    'downloads.list', 'downloads.create', 'downloads.get',
    'reports.list', 'reports.preferences', 'reports.updatePreferences', 'reports.unsubscribe', 'reports.get',
    'scheduledReports.list', 'scheduledReports.create', 'scheduledReports.update', 'scheduledReports.remove', 'scheduledReports.addRecipient', 'scheduledReports.removeRecipient',
    'apiKeys.list', 'apiKeys.create', 'apiKeys.revoke',
  ),
};
