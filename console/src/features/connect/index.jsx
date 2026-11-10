import { lazy } from 'react';
import { Link2 } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const ConnectPage = lazy(() => import('./ConnectPage.jsx'));

export default {
  name: 'connect',
  access: staffWith('automations'),
  nav: { to: '/connect', label: 'Instagram', icon: Link2, order: 66 },
  routes: [{ path: 'connect', element: <ConnectPage /> }],
};
