import LegalScreen from './LegalScreen.js';

/** The seller's privacy, terms, refund and shipping policies, shown in the app. */
export default {
  name: 'legal',
  screens: [
    { name: 'index', path: 'legal/:kind', title: 'legal.title', component: LegalScreen },
  ],
  nav: null,
  strings: {
    en: { 'legal.title': 'Policies', 'legal.kind.privacy': 'Privacy', 'legal.kind.terms': 'Terms', 'legal.kind.refund': 'Refunds', 'legal.kind.shipping': 'Shipping', 'legal.updated': 'Updated {date}' },
    hi: { 'legal.title': 'नीतियाँ', 'legal.kind.privacy': 'गोपनीयता', 'legal.kind.terms': 'शर्तें', 'legal.kind.refund': 'रिफ़ंड', 'legal.kind.shipping': 'शिपिंग', 'legal.updated': '{date} को अपडेट किया गया' },
  },
};
