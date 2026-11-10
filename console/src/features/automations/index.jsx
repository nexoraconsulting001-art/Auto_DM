import { lazy } from 'react';
import { Zap } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const AutomationsPage = lazy(() => import('./AutomationsPage.jsx'));
const BuilderPage = lazy(() => import('./BuilderPage.jsx'));

export default {
  name: 'automations',
  access: staffWith('automations'),
  nav: { to: '/automations', label: 'DM automations', icon: Zap, order: 31 },
  routes: [{ path: 'automations', element: <AutomationsPage /> }, { path: 'automations/:id', element: <BuilderPage /> }],
};
