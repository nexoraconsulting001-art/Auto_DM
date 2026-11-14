import { HeartPulse } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const HealthPage = screen(load, 'HealthPage');
const BusinessHealthPage = screen(load, 'BusinessHealthPage');

export default {
  name: 'health',
  roles: ['super_admin', 'support'],
  nav: { to: '/health', label: 'Health', icon: HeartPulse, order: 30 },
  routes: [
    { path: 'health', element: <HealthPage /> },
    { path: 'health/:id', element: <BusinessHealthPage /> },
  ],
};
