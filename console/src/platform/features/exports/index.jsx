import { Download } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const ExportsPage = screen(load, 'ExportsPage');

export default {
  name: 'exports',
  roles: ['super_admin'],
  nav: { to: '/exports', label: 'Exports', icon: Download, order: 110 },
  routes: [
    { path: 'exports', element: <ExportsPage /> },
  ],
};
