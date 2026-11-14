import { Flag } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const FlagsPage = screen(load, 'FlagsPage');

export default {
  name: 'flags',
  roles: ['super_admin', 'support'],
  nav: { to: '/flags', label: 'Flags', icon: Flag, order: 80 },
  routes: [
    { path: 'flags', element: <FlagsPage /> },
  ],
};
