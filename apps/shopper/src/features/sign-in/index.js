import SignInScreen from './SignInScreen.js';

/**
 * Sign in with Google or a WhatsApp code, and with Apple on iOS. Never needed to browse.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'sign-in',
  screens: [
    { name: 'index', path: 'sign-in', title: 'sign-in.title', component: SignInScreen },
  ],
  nav: null,
  strings: { en: { 'sign-in.title': 'Sign in' }, hi: { 'sign-in.title': 'साइन इन' } },
};
