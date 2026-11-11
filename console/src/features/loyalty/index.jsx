import { lazy } from 'react';
import { staffWith } from '@contracts/access.js';

const LoyaltyPage = lazy(() => import('./LoyaltyPage.jsx'));
const LoyaltySettingsPage = lazy(() => import('./LoyaltySettingsPage.jsx'));
const MemberPage = lazy(() => import('./MemberPage.jsx'));

/**
 * Loyalty points and referrals, an add-on (9.21). No menu entry: it is a tab of Customers that shows only when the add-on is
 * on, so a business without it never sees these screens (S-91). Opened directly, they say it isn't on the plan.
 */
export default {
  name: 'loyalty',
  access: staffWith('customers'),
  routes: [
    { path: 'loyalty', element: <LoyaltyPage /> },
    { path: 'loyalty/settings', element: <LoyaltySettingsPage /> },
    { path: 'loyalty/members/:id', element: <MemberPage /> },
  ],
};
