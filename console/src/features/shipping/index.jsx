import { lazy } from 'react';
import { MANAGERS } from '@contracts/access.js';

const ShippingPage = lazy(() => import('./ShippingPage.jsx'));

/** Courier settings (9.10), reached from Store setup. An order's parcels are on the order. */
export default {
  name: 'shipping',
  access: MANAGERS,
  routes: [{ path: 'shipping', element: <ShippingPage /> }],
};
