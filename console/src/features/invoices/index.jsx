import { lazy } from 'react';
import { staffWith } from '@contracts/access.js';

const InvoicesPage = lazy(() => import('./InvoicesPage.jsx'));
const InvoiceSettingsPage = lazy(() => import('./InvoiceSettingsPage.jsx'));

/** GST invoices and credit notes (9.13), reached from the Orders area; their settings from Store setup. */
export default {
  name: 'invoices',
  access: staffWith('orders'),
  routes: [
    { path: 'invoices', element: <InvoicesPage /> },
    { path: 'invoices/settings', element: <InvoiceSettingsPage /> },
  ],
};
