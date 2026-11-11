import { lazy } from 'react';
import { ClipboardList } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const LeadsPage = lazy(() => import('./LeadsPage.jsx'));
const LeadFormPage = lazy(() => import('./LeadFormPage.jsx'));

/** Leads and the form that collects them (PRD 8.15). Reading leads needs the customers permission; the form is for managers. */
export default {
  name: 'leads',
  access: staffWith('customers'),
  nav: { to: '/leads', label: 'Leads', icon: ClipboardList, order: 51 },
  routes: [
    { path: 'leads', element: <LeadsPage /> },
    { path: 'leads/form', element: <LeadFormPage /> },
  ],
};
