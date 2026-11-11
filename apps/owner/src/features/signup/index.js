import { PUBLIC } from '@bhava/app-core/access';
import SignupScreen from './SignupScreen.js';

/**
 * Create an account. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'signup',
  access: PUBLIC,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'signup', title: 'signup.title', component: SignupScreen }],
  nav: null,
  strings: { en: { 'signup.title': 'Create an account' }, hi: { 'signup.title': 'अकाउंट बनाएँ' } },
};
