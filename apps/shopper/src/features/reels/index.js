import Clapperboard from 'lucide-react-native/icons/clapperboard';
import ReelPageScreen from './ReelPageScreen.js';
import ReelsScreen from './ReelsScreen.js';

/** The Reels tab and one reel's own page, in each category's set order with pinned reels first (P-65). */
export default {
  name: 'reels',
  screens: [
    { name: 'index', path: 'reels', title: 'reels.title', component: ReelsScreen, link: true },
    { name: 'reel', path: 'r/:slug', title: 'reels.title', component: ReelPageScreen, link: true },
  ],
  nav: { label: 'reels.title', order: 30, icon: Clapperboard },
  strings: {
    en: { 'reels.title': 'Reels', 'reels.all': 'All', 'reels.empty': 'No reels yet', 'reels.products': 'In this reel', 'reels.more': 'More reels' },
    hi: { 'reels.title': 'रील्स', 'reels.all': 'सभी', 'reels.empty': 'अभी कोई रील नहीं है', 'reels.products': 'इस रील में', 'reels.more': 'और रील्स' },
  },
};
