import { Suspense, lazy } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { staffWith } from '@contracts/access.js';
import home from '../home/index.jsx';

const ReportsPage = lazy(() => import('./ReportsPage.jsx'));
const ScheduledPage = lazy(() => import('./ScheduledPage.jsx'));
const ApiKeysPage = lazy(() => import('./ApiKeysPage.jsx'));
const PinnedViews = lazy(() => import('./PinnedViews.jsx'));

/**
 * Saved views pinned to the dashboard belong on Home (PRD 7.11, N-54), and Home has no slot for another feature's cards. As the
 * compliance banner does, this adds them to Home's route as the feature list is built. Replace it with a slot when Home has one.
 */
home.routes = home.routes.map((route) => (route.index
  ? { ...route, element: <>{route.element}<Suspense fallback={null}><PinnedViews /></Suspense></> }
  : route));

/** Summary files, weekly and monthly reports, scheduled reports and the reporting API's keys (PRD 7.9, 7.13). Summary figures only, never a list of single visits. */
export default {
  name: 'reports',
  access: staffWith('analytics'),
  nav: { to: '/reports', label: 'Reports', icon: FileSpreadsheet, order: 36 },
  routes: [
    { path: 'reports', element: <ReportsPage /> },
    { path: 'reports/scheduled', element: <ScheduledPage /> },
    { path: 'settings/api-keys', element: <ApiKeysPage /> },
  ],
};
