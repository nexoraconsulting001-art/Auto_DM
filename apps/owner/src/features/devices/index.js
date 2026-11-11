import { SIGNED_IN } from '@bhava/app-core/access';
import DevicesScreen from './DevicesScreen.js';

/**
 * Devices. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'devices',
  access: SIGNED_IN,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'devices', title: 'devices.title', component: DevicesScreen }],
  nav: { label: 'devices.title', order: 77 },
  strings: { en: { 'devices.title': 'Devices' }, hi: { 'devices.title': 'डिवाइस' } },
};
