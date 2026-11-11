import { staffWith } from '@bhava/app-core/access';
import ActivityScreen from './ActivityScreen.js';

/**
 * Activity. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'activity',
  access: staffWith('automations'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'activity', title: 'activity.title', component: ActivityScreen }],
  nav: { label: 'activity.title', order: 60 },
  strings: { en: { 'activity.title': 'Activity' }, hi: { 'activity.title': 'गतिविधि' } },
};
