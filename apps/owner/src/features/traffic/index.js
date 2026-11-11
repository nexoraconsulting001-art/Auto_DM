import { staffWith } from '@bhava/app-core/access';
import TrafficScreen from './TrafficScreen.js';

/**
 * Traffic. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'traffic',
  access: staffWith('analytics'),
  feature: 'traffic.pages',
  routeIds: [],
  screens: [{ name: 'index', path: 'traffic', title: 'traffic.title', component: TrafficScreen }],
  nav: { label: 'traffic.title', order: 34 },
  strings: { en: { 'traffic.title': 'Traffic' }, hi: { 'traffic.title': 'ट्रैफ़िक' } },
};
