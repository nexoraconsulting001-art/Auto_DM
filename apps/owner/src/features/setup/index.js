import { SIGNED_IN } from '@bhava/app-core/access';
import SetupScreen from './SetupScreen.js';

/**
 * Setup. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'setup',
  access: SIGNED_IN,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'setup', title: 'setup.title', component: SetupScreen }],
  nav: null,
  strings: { en: { 'setup.title': 'Setup' }, hi: { 'setup.title': 'सेटअप' } },
};
