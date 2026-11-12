import AddressesScreen from './AddressesScreen.js';

/**
 * Saved addresses: add, change, remove, and pick one at checkout.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'addresses',
  screens: [
    { name: 'index', path: 'account/addresses', title: 'addresses.title', component: AddressesScreen },
  ],
  nav: null,
  strings: { en: { 'addresses.title': 'Addresses' }, hi: { 'addresses.title': 'पते' } },
};
