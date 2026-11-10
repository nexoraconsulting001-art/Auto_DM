import { lazy } from 'react';
import { ShoppingBag } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const OrdersPage = lazy(() => import('./OrdersPage.jsx'));
const OrderPage = lazy(() => import('./OrderPage.jsx'));

export default {
  name: 'orders',
  access: staffWith('orders'),
  nav: { to: '/orders', label: 'Orders', icon: ShoppingBag, order: 10, primary: true, count: (stats) => stats.toConfirm },
  routes: [{ path: 'orders', element: <OrdersPage /> }, { path: 'orders/:id', element: <OrderPage /> }],
};
