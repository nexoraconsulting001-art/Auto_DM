import { SIGNED_IN } from '@bhava/app-core/access';
import NotificationsScreen from './NotificationsScreen.js';

/**
 * Notifications. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'notifications',
  access: SIGNED_IN,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'notifications', title: 'notifications.title', component: NotificationsScreen }],
  nav: { label: 'notifications.title', order: 62 },
  strings: { en: { 'notifications.title': 'Notifications' }, hi: { 'notifications.title': 'नोटिफ़िकेशन' } },
};
