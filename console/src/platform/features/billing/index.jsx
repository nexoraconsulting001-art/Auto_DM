import { CreditCard } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const BillingPage = screen(load, 'BillingPage');
const BillingSettingsPage = screen(load, 'BillingSettingsPage');
const BusinessBillingPage = screen(load, 'BusinessBillingPage');

export default {
  name: 'billing',
  roles: ['super_admin', 'support'],
  nav: { to: '/billing', label: 'Billing', icon: CreditCard, order: 70 },
  routes: [
    { path: 'billing', element: <BillingPage /> },
    { path: 'billing/settings', element: <BillingSettingsPage /> },
    { path: 'billing/:id', element: <BusinessBillingPage /> },
  ],
};
