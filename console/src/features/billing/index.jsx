import { lazy } from 'react';
import { CreditCard } from 'lucide-react';
import { OWNER_ONLY } from '@contracts/access.js';
import { installUpgradeWatch } from './upgrade-watch.js';
import { mountUpgradeHost } from './UpgradePrompt.jsx';

const BillingPage = lazy(() => import('./BillingPage.jsx'));

// Wherever the server answers plan.feature_off or plan.limit_reached, one upgrade prompt shows (PRD 5.7). The server is the guard.
installUpgradeWatch();
mountUpgradeHost();

/** Plan and billing (PRD 3, 5.12): the plan, plans and add-ons with the server's prices, usage, invoices and statements. */
export default {
  name: 'billing',
  access: OWNER_ONLY,
  nav: { to: '/billing', label: 'Plan and billing', icon: CreditCard, order: 82 },
  routes: [{ path: 'billing', element: <BillingPage /> }],
};
