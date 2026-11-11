import { MANAGERS } from '@bhava/app-core/access';
import PrivacyScreen from './PrivacyScreen.js';

/**
 * Privacy. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'privacy',
  access: MANAGERS,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'privacy', title: 'privacy.title', component: PrivacyScreen }],
  nav: { label: 'privacy.title', order: 53 },
  strings: { en: { 'privacy.title': 'Privacy' }, hi: { 'privacy.title': 'प्राइवेसी' } },
};
