import { Activity } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const ObservabilityPage = screen(load, 'ObservabilityPage');
const BusinessObservabilityPage = screen(load, 'BusinessObservabilityPage');

export default {
  name: 'observability',
  roles: ['super_admin', 'support'],
  nav: { to: '/observability', label: 'Observability', icon: Activity, order: 35 },
  routes: [
    { path: 'observability', element: <ObservabilityPage /> },
    { path: 'observability/:id', element: <BusinessObservabilityPage /> },
  ],
};
