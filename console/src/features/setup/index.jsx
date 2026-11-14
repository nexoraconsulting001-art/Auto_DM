import { lazy } from 'react';
import { ListChecks } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const SetupPage = lazy(() => import('./SetupPage.jsx'));

/** The setup checklist with live step states (PRD 5.6): KYC, pickup address, terms and a business's own keys. */
export default {
  name: 'setup',
  access: MANAGERS,
  nav: { to: '/setup', label: 'Setup checklist', icon: ListChecks, order: 5 },
  routes: [{ path: 'setup', element: <SetupPage /> }],
};
