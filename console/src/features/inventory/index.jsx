import { lazy } from 'react';
import { Boxes } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const InventoryPage = lazy(() => import('./InventoryPage.jsx'));
const MovementsPage = lazy(() => import('./MovementsPage.jsx'));

/** Stock per product and option, with what is held for orders being paid for (9.12). */
export default {
  name: 'inventory',
  access: staffWith('catalog'),
  nav: { to: '/inventory', label: 'Stock', icon: Boxes, order: 24 },
  routes: [
    { path: 'inventory', element: <InventoryPage /> },
    { path: 'inventory/movements', element: <MovementsPage /> },
  ],
};
