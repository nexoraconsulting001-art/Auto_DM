import { SIGNED_IN } from '@bhava/app-core/access';
import AccountScreen from './AccountScreen.js';

/**
 * Your account. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'account',
  access: SIGNED_IN,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'account', title: 'account.title', component: AccountScreen }],
  nav: { label: 'account.title', order: 78 },
  strings: { en: { 'account.title': 'Your account' }, hi: { 'account.title': 'आपका अकाउंट' } },
};
