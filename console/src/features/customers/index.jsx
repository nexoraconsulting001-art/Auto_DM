import { lazy } from 'react';
import { Users } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const CustomersPage = lazy(() => import('./CustomersPage.jsx'));

export default {
  name: 'customers',
  access: staffWith('customers'),
  nav: { to: '/customers', label: 'Customers', icon: Users, order: 50 },
  routes: [{ path: 'customers', element: <CustomersPage /> }],
};
