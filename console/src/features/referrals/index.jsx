import { lazy } from 'react';
import { Gift } from 'lucide-react';
import { OWNER_ONLY } from '@contracts/access.js';

const ReferralsPage = lazy(() => import('./ReferralsPage.jsx'));

/** The seller's referral link and what it has earned (PRD 5.20). */
export default {
  name: 'referrals',
  access: OWNER_ONLY,
  nav: { to: '/referrals', label: 'Refer a seller', icon: Gift, order: 84 },
  routes: [{ path: 'referrals', element: <ReferralsPage /> }],
};
