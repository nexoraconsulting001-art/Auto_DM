import PaymentScreen from './PaymentScreen.js';

/**
 * Paying for a placed order through @bhava/pay, and what the server then says of it (P-29).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'payment',
  screens: [
    { name: 'index', path: 'pay/:token', title: 'payment.title', component: PaymentScreen },
  ],
  nav: null,
  strings: { en: { 'payment.title': 'Payment' }, hi: { 'payment.title': 'भुगतान' } },
};
