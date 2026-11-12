import CheckoutScreen from './CheckoutScreen.js';

/**
 * Guest checkout by default: address, way of paying, codes; cash on delivery asks for a WhatsApp code (P-28).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'checkout',
  screens: [
    { name: 'index', path: 'checkout', title: 'checkout.title', component: CheckoutScreen },
  ],
  nav: null,
  strings: { en: { 'checkout.title': 'Checkout' }, hi: { 'checkout.title': 'चेकआउट' } },
};
