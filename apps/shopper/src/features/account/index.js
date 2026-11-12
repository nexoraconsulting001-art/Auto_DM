import User from 'lucide-react-native/icons/user';
import AccountScreen from './AccountScreen.js';

/**
 * The shopper’s own page: profile, settings and “Delete my account” (P-30).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'account',
  screens: [
    { name: 'index', path: 'account', title: 'account.title', component: AccountScreen },
    { name: 'delete', path: 'account/delete', title: 'account.title', component: AccountScreen },
  ],
  nav: { label: 'account.title', order: 50, icon: User },
  strings: { en: { 'account.title': 'Account' }, hi: { 'account.title': 'खाता' } },
};
