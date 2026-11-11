import { staffWith } from '@bhava/app-core/access';
import ReportsScreen from './ReportsScreen.js';

/**
 * Reports. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'reports',
  access: staffWith('analytics'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'reports', title: 'reports.title', component: ReportsScreen }],
  nav: { label: 'reports.title', order: 36 },
  strings: { en: { 'reports.title': 'Reports' }, hi: { 'reports.title': 'रिपोर्ट' } },
};
