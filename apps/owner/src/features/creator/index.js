import { MANAGERS } from '@bhava/app-core/access';
import CreatorScreen from './CreatorScreen.js';

/**
 * Creator page. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'creator',
  access: MANAGERS,
  feature: 'creator_page',
  routeIds: [],
  screens: [{ name: 'index', path: 'creator', title: 'creator.title', component: CreatorScreen }],
  nav: { label: 'creator.title', order: 23 },
  strings: { en: { 'creator.title': 'Creator page' }, hi: { 'creator.title': 'क्रिएटर पेज' } },
};
