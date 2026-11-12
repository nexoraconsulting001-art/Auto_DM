import RewardsScreen from './RewardsScreen.js';

/**
 * Points, their history and the referral link, in the seller’s brand (P-66).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'rewards',
  screens: [
    { name: 'index', path: 'account/rewards', title: 'rewards.title', component: RewardsScreen },
    { name: 'referral', path: 'refer/:code', title: 'rewards.title', component: RewardsScreen, link: true },
  ],
  nav: null,
  strings: { en: { 'rewards.title': 'Rewards' }, hi: { 'rewards.title': 'रिवॉर्ड' } },
};
