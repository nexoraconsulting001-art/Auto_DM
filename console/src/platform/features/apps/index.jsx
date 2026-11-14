import { Smartphone } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const AppsPage = screen(load, 'AppsPage');

export default {
  name: 'apps',
  roles: ['super_admin', 'support'],
  nav: { to: '/apps', label: 'Apps', icon: Smartphone, order: 100 },
  routes: [
    { path: 'apps', element: <AppsPage /> },
  ],
};
