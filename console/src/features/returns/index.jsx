import { lazy } from 'react';
import { Undo2 } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const ReturnsPage = lazy(() => import('./ReturnsPage.jsx'));
const ReturnSettingsPage = lazy(() => import('./ReturnSettingsPage.jsx'));
const ReturnPage = lazy(() => import('./ReturnPage.jsx'));

/** Returns with proof (9.17). Proof files show only to the owner and staff with order access. */
export default {
  name: 'returns',
  access: staffWith('orders'),
  nav: { to: '/returns', label: 'Returns', icon: Undo2, order: 11 },
  routes: [
    { path: 'returns', element: <ReturnsPage /> },
    { path: 'returns/settings', element: <ReturnSettingsPage /> },
    { path: 'returns/:id', element: <ReturnPage /> },
  ],
};
