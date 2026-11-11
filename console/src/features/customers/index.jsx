import { lazy } from 'react';
import { Users } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const CustomersPage = lazy(() => import('./CustomersPage.jsx'));
const ShoppersPage = lazy(() => import('./ShoppersPage.jsx'));
const ShopperPage = lazy(() => import('./ShopperPage.jsx'));
const DataRequestsPage = lazy(() => import('./DataRequestsPage.jsx'));

/** This business's own customers only (9.17, 9.22), their data requests (9.18), and the accounts with a password. */
export default {
  name: 'customers',
  access: staffWith('customers'),
  nav: { to: '/customers', label: 'Customers', icon: Users, order: 50 },
  routes: [
    { path: 'customers', element: <CustomersPage /> },
    { path: 'customers/shoppers', element: <ShoppersPage /> },
    { path: 'customers/shoppers/:id', element: <ShopperPage /> },
    { path: 'customers/data-requests', element: <DataRequestsPage /> },
  ],
};
