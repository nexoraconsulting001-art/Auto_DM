import WishlistScreen from './WishlistScreen.js';

/**
 * Saved products, kept on the device and merged after sign-in.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'wishlist',
  screens: [
    { name: 'index', path: 'wishlist', title: 'wishlist.title', component: WishlistScreen },
  ],
  nav: null,
  strings: { en: { 'wishlist.title': 'Wishlist' }, hi: { 'wishlist.title': 'विशलिस्ट' } },
};
