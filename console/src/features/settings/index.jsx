import { lazy } from 'react';
import { Settings } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const SettingsPage = lazy(() => import('./SettingsPage.jsx'));

export default {
  name: 'settings',
  access: MANAGERS,
  nav: { to: '/settings', label: 'Settings', icon: Settings, order: 70 },
  routes: [{ path: 'settings', element: <SettingsPage /> }],
};
