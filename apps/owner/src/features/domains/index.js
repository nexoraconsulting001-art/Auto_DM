import { MANAGERS } from '@bhava/app-core/access';
import DomainsScreen from './DomainsScreen.js';

/**
 * Domains. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'domains',
  access: MANAGERS,
  feature: 'custom_domain',
  routeIds: [],
  screens: [{ name: 'index', path: 'domains', title: 'domains.title', component: DomainsScreen }],
  nav: { label: 'domains.title', order: 75 },
  strings: { en: { 'domains.title': 'Domains' }, hi: { 'domains.title': 'डोमेन' } },
};
