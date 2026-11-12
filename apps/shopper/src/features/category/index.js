import CategoryScreen from './CategoryScreen.js';

/** One category: its reels in the set order, pinned first, then its products. */
export default {
  name: 'category',
  screens: [
    { name: 'index', path: 'c/:slug', title: 'category.title', component: CategoryScreen, link: true },
  ],
  nav: null,
  strings: {
    en: { 'category.title': 'Category', 'category.reels': 'Reels', 'category.products': 'Products', 'category.empty': 'No products in this category yet' },
    hi: { 'category.title': 'श्रेणी', 'category.reels': 'रील्स', 'category.products': 'प्रोडक्ट', 'category.empty': 'इस श्रेणी में अभी कोई प्रोडक्ट नहीं है' },
  },
};
