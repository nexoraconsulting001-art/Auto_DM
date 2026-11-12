import LegalScreen from './LegalScreen.js';

/**
 * The seller’s privacy, terms, refund and shipping policies, shown in the app.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'legal',
  screens: [
    { name: 'index', path: 'legal/:kind', title: 'legal.title', component: LegalScreen },
  ],
  nav: null,
  strings: { en: { 'legal.title': 'Policies' }, hi: { 'legal.title': 'नीतियाँ' } },
};
