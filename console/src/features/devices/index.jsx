import { lazy } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { SIGNED_IN } from '@contracts/access.js';

const DevicesPage = lazy(() => import('./DevicesPage.jsx'));

/** Settings > Devices (PRD 10.2, P-08). The path is the one the server's "New sign-in" notice links to. */
export default {
  name: 'devices',
  access: SIGNED_IN,
  nav: { to: '/settings/devices', label: 'Devices', icon: MonitorSmartphone, order: 77 },
  routes: [{ path: 'settings/devices', element: <DevicesPage /> }],
};
