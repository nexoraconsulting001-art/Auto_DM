import { staffWith } from '@bhava/app-core/access';
import InsightsScreen from './InsightsScreen.js';

/**
 * Insights. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'insights',
  access: staffWith('analytics'),
  feature: 'analytics',
  routeIds: [],
  screens: [{ name: 'index', path: 'insights', title: 'insights.title', component: InsightsScreen }],
  nav: { label: 'insights.title', order: 33 },
  strings: { en: { 'insights.title': 'Insights' }, hi: { 'insights.title': 'इनसाइट' } },
};
