import { staffWith } from '@bhava/app-core/access';
import AutomationsScreen from './AutomationsScreen.js';

/**
 * Automations. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'automations',
  access: staffWith('automations'),
  feature: 'automations',
  routeIds: [],
  screens: [{ name: 'index', path: 'automations', title: 'automations.title', component: AutomationsScreen }],
  nav: { label: 'automations.title', order: 31 },
  strings: { en: { 'automations.title': 'Automations' }, hi: { 'automations.title': 'ऑटोमेशन' } },
};
