import { Eye } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const ImpersonationPage = screen(load, 'ImpersonationPage');

export default {
  name: 'impersonation',
  roles: ['super_admin', 'support'],
  nav: { to: '/impersonation', label: 'Impersonation', icon: Eye, order: 50 },
  routes: [
    { path: 'impersonation', element: <ImpersonationPage /> },
  ],
};
