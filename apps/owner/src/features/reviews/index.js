import { staffWith } from '@bhava/app-core/access';
import ReviewsScreen from './ReviewsScreen.js';

/**
 * Reviews. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'reviews',
  access: staffWith('catalog'),
  feature: 'store.reviews',
  routeIds: [],
  screens: [{ name: 'index', path: 'reviews', title: 'reviews.title', component: ReviewsScreen }],
  nav: { label: 'reviews.title', order: 26 },
  strings: { en: { 'reviews.title': 'Reviews' }, hi: { 'reviews.title': 'रिव्यू' } },
};
