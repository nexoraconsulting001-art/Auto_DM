import SearchScreen from './SearchScreen.js';

/**
 * Search across the store’s products.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'search',
  screens: [
    { name: 'index', path: 'search', title: 'search.title', component: SearchScreen },
  ],
  nav: null,
  strings: { en: { 'search.title': 'Search' }, hi: { 'search.title': 'खोजें' } },
};
