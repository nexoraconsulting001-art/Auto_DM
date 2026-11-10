import { Suspense, lazy } from 'react';
import { ShieldAlert } from 'lucide-react';
import { staffWith } from '@contracts/access.js';
import home from '../home/index.jsx';

const ReachGuardPage = lazy(() => import('./ReachGuardPage.jsx'));
const HealthPage = lazy(() => import('./HealthPage.jsx'));
const GuardNotice = lazy(() => import('./GuardNotice.jsx'));

/**
 * A trip is announced on Home as a web banner (PRD 7.6), and Home has no slot for another feature's banner. As the compliance banner
 * does, this adds it to Home's route as the feature list is built. Replace it with a slot when Home has one.
 */
home.routes = home.routes.map((route) => (route.index
  ? { ...route, element: <><Suspense fallback={null}><GuardNotice /></Suspense>{route.element}</> }
  : route));

/** Reach Guard and the Account Health score (PRD 7.6, 7.7). The override itself is compliance's, with the owner rule and typed word. */
export default {
  name: 'reach-guard',
  access: staffWith('analytics'),
  nav: { to: '/reach-guard', label: 'Reach Guard', icon: ShieldAlert, order: 35 },
  routes: [
    { path: 'reach-guard', element: <ReachGuardPage /> },
    { path: 'account-health', element: <HealthPage /> },
  ],
};
