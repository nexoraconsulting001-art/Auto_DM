import { OWNER_ONLY } from '@bhava/app-core/access';
import TeamScreen from './TeamScreen.js';

/**
 * Team. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'team',
  access: OWNER_ONLY,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'team', title: 'team.title', component: TeamScreen }],
  nav: { label: 'team.title', order: 76 },
  strings: { en: { 'team.title': 'Team' }, hi: { 'team.title': 'टीम' } },
};
