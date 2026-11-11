import { lazy } from 'react';
import { Wallet } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const PaymentsPage = lazy(() => import('./PaymentsPage.jsx'));
const StatementPage = lazy(() => import('./StatementPage.jsx'));

/** How the business is paid (9.6) and its settlement statement. An order's own payments and refunds are on the order. */
export default {
  name: 'payments',
  access: MANAGERS,
  nav: { to: '/payments', label: 'Payments', icon: Wallet, order: 71 },
  routes: [
    { path: 'payments', element: <PaymentsPage /> },
    { path: 'payments/statement', element: <StatementPage /> },
  ],
};
