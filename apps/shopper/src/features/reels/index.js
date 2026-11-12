import Clapperboard from 'lucide-react-native/icons/clapperboard';
import ReelsScreen from './ReelsScreen.js';

/**
 * The Reels tab and one reel’s own page, in each category’s set order with pinned reels first (P-65).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'reels',
  screens: [
    { name: 'index', path: 'reels', title: 'reels.title', component: ReelsScreen, link: true },
    { name: 'reel', path: 'r/:slug', title: 'reels.title', component: ReelsScreen, link: true },
  ],
  nav: { label: 'reels.title', order: 30, icon: Clapperboard },
  strings: { en: { 'reels.title': 'Reels' }, hi: { 'reels.title': 'रील्स' } },
};
