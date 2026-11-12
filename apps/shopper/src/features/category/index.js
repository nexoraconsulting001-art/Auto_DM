import CategoryScreen from './CategoryScreen.js';

/**
 * One category: its reels in the set order, then its products.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'category',
  screens: [
    { name: 'index', path: 'c/:slug', title: 'category.title', component: CategoryScreen, link: true },
  ],
  nav: null,
  strings: { en: { 'category.title': 'Category' }, hi: { 'category.title': 'श्रेणी' } },
};
