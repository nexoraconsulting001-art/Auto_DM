import { notBuilt } from '../not-built.js';
import { reportsApi } from './api.js';
import { registerReportJobs } from './jobs.js';
import { registerPages } from './pages.js';
import { registerReportingApi } from './reporting-api.js';
import { reportServices } from './services.js';

/**
 * Explore, saved views, custom funnels and cohorts (7.11, 7.12) are built by the traffic track, which answers these ids while they are stubs here
 * (see adoptContractStubs in src/modules/traffic/index.js). They stay listed so each route still has one owner in this module.
 */
const ANSWERED_BY_TRAFFIC = [
  'explore.catalog', 'explore.query',
  'savedViews.list', 'savedViews.create', 'savedViews.get', 'savedViews.update', 'savedViews.remove', 'savedViews.pin', 'savedViews.unpin',
  'dashboard.cards',
  'funnels.list', 'funnels.create', 'funnels.get', 'funnels.update', 'funnels.remove', 'funnels.results',
  'cohorts.get',
];

/**
 * PRD 7.9 and 7.13: summary downloads as CSV or Excel, the weekly and monthly reports, scheduled reports of any saved view, and the reporting API.
 * Everything is built from the cache and the rollups, for one business, with what the person's role and the plan allow; nothing here calls Meta or
 * sends a message. Emails and pushes wait in report_deliveries for the notifications framework (5.13).
 */
export const reports = {
  name: 'reports',

  /** The reporting API is signed by key, not session, and the key names the business, so it comes before the web address is looked at. */
  beforeTenant(app, ctx) {
    registerReportingApi(app, ctx);
  },

  routes(app, ctx) {
    const services = () => reportServices(ctx);
    registerPages(app, {
      reports: services,
      fileFor: (ref, user) => (ref.kind === 'download' ? services().downloads.file(ref.id, user) : services().runs.file(ref.id, user)),
    });
  },

  api: (ctx) => ({ ...notBuilt(...ANSWERED_BY_TRAFFIC), ...reportsApi(ctx) }),

  jobs: (ctx) => registerReportJobs(ctx),
};
