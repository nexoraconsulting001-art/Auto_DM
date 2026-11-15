import { Rocket } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const GolivePage = screen(load, 'GolivePage');

export default {
  name: 'golive',
  roles: ['super_admin', 'support'],
  nav: { to: '/golive', label: 'Go-live', icon: Rocket, order: 88 },
  routes: [
    { path: 'golive', element: <GolivePage /> },
  ],
};
