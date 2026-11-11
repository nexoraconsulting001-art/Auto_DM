import { staffWith } from '@bhava/app-core/access';
import ConnectScreen from './ConnectScreen.js';

/**
 * Connect Instagram. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'connect',
  access: staffWith('automations'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'connect', title: 'connect.title', component: ConnectScreen }],
  nav: { label: 'connect.title', order: 66 },
  strings: { en: { 'connect.title': 'Connect Instagram' }, hi: { 'connect.title': 'Instagram जोड़ें' } },
};
