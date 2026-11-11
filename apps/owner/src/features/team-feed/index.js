import { SIGNED_IN } from '@bhava/app-core/access';
import TeamFeedScreen from './TeamFeedScreen.js';

/**
 * Team feed. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'team-feed',
  access: SIGNED_IN,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'team-feed', title: 'team-feed.title', component: TeamFeedScreen }],
  nav: null,
  strings: { en: { 'team-feed.title': 'Team feed' }, hi: { 'team-feed.title': 'टीम फ़ीड' } },
};
