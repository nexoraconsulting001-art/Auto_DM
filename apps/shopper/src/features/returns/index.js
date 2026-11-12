import ReturnsScreen from './ReturnsScreen.js';

/**
 * Asking to return an order, with at least one photo or short video.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'returns',
  screens: [
    { name: 'index', path: 'account/orders/:orderNumber/return', title: 'returns.title', component: ReturnsScreen },
  ],
  nav: null,
  strings: { en: { 'returns.title': 'Return an order' }, hi: { 'returns.title': 'ऑर्डर लौटाएँ' } },
};
