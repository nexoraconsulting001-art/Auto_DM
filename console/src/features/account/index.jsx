import { lazy } from 'react';
import { CircleUserRound } from 'lucide-react';
import { SIGNED_IN } from '@contracts/access.js';
// The business this tab works in, and the watch that signs a revoked session out without a reload: both start with the console.
import './live.js';

const AccountPage = lazy(() => import('./AccountPage.jsx'));

/**
 * Settings > Your account (PRD 5.11, 10.3, 10.6): who you are, the business switcher, the ways you sign in, and Delete
 * my account. The path is the one the server's account notices link to.
 */
export default {
  name: 'account',
  access: SIGNED_IN,
  nav: { to: '/settings/account', label: 'Your account', icon: CircleUserRound, order: 78 },
  routes: [{ path: 'settings/account', element: <AccountPage /> }],
};
