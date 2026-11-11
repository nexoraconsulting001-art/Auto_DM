import { lazy } from 'react';
import { staffWith } from '@contracts/access.js';

const ImportPage = lazy(() => import('./ImportPage.jsx'));
const ImportJobPage = lazy(() => import('./ImportJobPage.jsx'));

/** Bringing products in from the seller's own website (PRD 8.3 to 8.7). Reached from the catalog, so it has no menu entry of its own. */
export default {
  name: 'imports',
  access: staffWith('catalog'),
  routes: [
    { path: 'imports', element: <ImportPage /> },
    { path: 'imports/:id', element: <ImportJobPage /> },
  ],
};
