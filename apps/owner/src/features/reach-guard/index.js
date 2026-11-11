import { staffWith } from '@bhava/app-core/access';
import ReachGuardScreen from './ReachGuardScreen.js';

/**
 * Reach Guard. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'reach-guard',
  access: staffWith('analytics'),
  feature: 'reach_guard',
  routeIds: [],
  screens: [{ name: 'index', path: 'reach-guard', title: 'reach-guard.title', component: ReachGuardScreen }],
  nav: { label: 'reach-guard.title', order: 35 },
  strings: { en: { 'reach-guard.title': 'Reach Guard' }, hi: { 'reach-guard.title': 'रीच गार्ड' } },
};
