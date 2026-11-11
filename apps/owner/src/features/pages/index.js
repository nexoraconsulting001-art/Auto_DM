import { staffWith } from '@bhava/app-core/access';
import PagesScreen from './PagesScreen.js';

/**
 * Pages. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'pages',
  access: staffWith('catalog'),
  feature: 'landing_pages',
  routeIds: [],
  screens: [{ name: 'index', path: 'pages', title: 'pages.title', component: PagesScreen }],
  nav: { label: 'pages.title', order: 22 },
  strings: { en: { 'pages.title': 'Pages' }, hi: { 'pages.title': 'पेज' } },
};
