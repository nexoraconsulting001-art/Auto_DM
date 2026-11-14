import { Power } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const SwitchesPage = screen(load, 'SwitchesPage');

export default {
  name: 'switches',
  roles: ['super_admin', 'support'],
  nav: { to: '/switches', label: 'Pauses', icon: Power, order: 40 },
  routes: [
    { path: 'switches', element: <SwitchesPage /> },
  ],
};
