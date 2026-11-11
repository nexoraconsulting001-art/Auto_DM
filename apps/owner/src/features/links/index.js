import { staffWith } from '@bhava/app-core/access';
import LinksScreen from './LinksScreen.js';

/**
 * Links. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'links',
  access: staffWith('automations'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'links', title: 'links.title', component: LinksScreen }],
  nav: { label: 'links.title', order: 63 },
  strings: { en: { 'links.title': 'Links' }, hi: { 'links.title': 'लिंक' } },
};
