import ShoppingCart from 'lucide-react-native/icons/shopping-cart';
import CartScreen from './CartScreen.js';

/**
 * The bag: lines priced by the server, quantities, and the way to checkout.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'cart',
  screens: [
    { name: 'index', path: 'cart', title: 'cart.title', component: CartScreen, link: true },
  ],
  nav: { label: 'cart.title', order: 40, icon: ShoppingCart },
  strings: { en: { 'cart.title': 'Cart' }, hi: { 'cart.title': 'कार्ट' } },
};
