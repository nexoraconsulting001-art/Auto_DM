import ProductScreen from './ProductScreen.js';

/**
 * One product: photos, options, price, reviews and Add to cart.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'product',
  screens: [
    { name: 'index', path: 'p/:slug', title: 'product.title', component: ProductScreen, link: true },
  ],
  nav: null,
  strings: { en: { 'product.title': 'Product' }, hi: { 'product.title': 'प्रोडक्ट' } },
};
