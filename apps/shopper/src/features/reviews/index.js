import ReviewsScreen from './ReviewsScreen.js';

/**
 * A product’s reviews, and writing one for something that was delivered.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'reviews',
  screens: [
    { name: 'index', path: 'reviews/:productId', title: 'reviews.title', component: ReviewsScreen },
  ],
  nav: null,
  strings: { en: { 'reviews.title': 'Reviews' }, hi: { 'reviews.title': 'समीक्षाएँ' } },
};
