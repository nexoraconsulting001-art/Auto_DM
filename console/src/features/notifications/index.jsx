import { lazy } from 'react';
import { Bell } from 'lucide-react';
import { SIGNED_IN } from '@contracts/access.js';

const NotificationsPage = lazy(() => import('./NotificationsPage.jsx'));
const NotificationSettingsPage = lazy(() => import('./NotificationSettingsPage.jsx'));

/** What Bhava tells this person (PRD 5.13, 10.5): the in-app list, and the choices per kind and channel with quiet hours. */
export default {
  name: 'notifications',
  access: SIGNED_IN,
  nav: { to: '/notifications', label: 'Notifications', icon: Bell, order: 62 },
  routes: [
    { path: 'notifications', element: <NotificationsPage /> },
    { path: 'notifications/settings', element: <NotificationSettingsPage /> },
  ],
};
