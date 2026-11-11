import { MANAGERS } from '@bhava/app-core/access';
import ReferralsScreen from './ReferralsScreen.js';

/**
 * Referrals. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'referrals',
  access: MANAGERS,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'referrals', title: 'referrals.title', component: ReferralsScreen }],
  nav: null,
  strings: { en: { 'referrals.title': 'Referrals' }, hi: { 'referrals.title': 'रेफ़रल' } },
};
