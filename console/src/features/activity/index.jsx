import { lazy } from 'react';
import { MessageCircle } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const ActivityPage = lazy(() => import('./ActivityPage.jsx'));

export default {
  name: 'activity',
  access: staffWith('automations'),
  nav: { to: '/activity', label: 'DM activity', icon: MessageCircle, order: 60 },
  routes: [{ path: 'activity', element: <ActivityPage /> }],
};
