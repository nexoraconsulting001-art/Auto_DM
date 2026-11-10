import { Suspense, lazy } from 'react';
import { ShieldCheck } from 'lucide-react';
import { staffWith } from '@contracts/access.js';
import home from '../home/index.jsx';

const CompliancePage = lazy(() => import('./CompliancePage.jsx'));
const ComplianceLogPage = lazy(() => import('./ComplianceLogPage.jsx'));
const ComplianceSettingsPage = lazy(() => import('./ComplianceSettingsPage.jsx'));
const HomeNotices = lazy(() => import('./HomeNotices.jsx'));

/**
 * The status banner belongs above the dashboard, and neither the shell nor Home has a place for another feature's banner.
 * Until one of them does, this adds it to Home's route as the feature list is built. Replace it with a slot in the shell.
 */
home.routes = home.routes.map((route) => (route.index
  ? { ...route, element: <><Suspense fallback={null}><HomeNotices /></Suspense>{route.element}</> }
  : route));

export default {
  name: 'compliance',
  access: staffWith('automations'),
  nav: { to: '/compliance', label: 'Compliance', icon: ShieldCheck, order: 64 },
  routes: [
    { path: 'compliance', element: <CompliancePage /> },
    { path: 'compliance/log', element: <ComplianceLogPage /> },
    { path: 'compliance/settings', element: <ComplianceSettingsPage /> },
  ],
};
