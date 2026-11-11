import { SIGNED_IN } from '@bhava/app-core/access';
import AlertsScreen from './AlertsScreen.js';

/**
 * Alerts. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'alerts',
  access: SIGNED_IN,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'alerts', title: 'alerts.title', component: AlertsScreen }],
  nav: { label: 'alerts.title', order: 61 },
  strings: { en: { 'alerts.title': 'Alerts' }, hi: { 'alerts.title': 'अलर्ट' } },
};
