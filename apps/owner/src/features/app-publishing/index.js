import { OWNER_ONLY } from '@bhava/app-core/access';
import AppPublishingScreen from './AppPublishingScreen.js';

/**
 * Your app. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'app-publishing',
  access: OWNER_ONLY,
  feature: 'app.android',
  routeIds: [],
  screens: [{ name: 'index', path: 'app-publishing', title: 'app-publishing.title', component: AppPublishingScreen }],
  nav: null,
  strings: { en: { 'app-publishing.title': 'Your app' }, hi: { 'app-publishing.title': 'आपका ऐप' } },
};
