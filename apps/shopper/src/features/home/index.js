import House from 'lucide-react-native/icons/house';
import HomeScreen from './HomeScreen.js';

/**
 * The store’s front page: the blocks the seller arranged, from the home feed.
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'home',
  screens: [
    { name: 'index', path: '', title: 'home.title', component: HomeScreen, link: true },
  ],
  nav: { label: 'home.title', order: 10, icon: House },
  strings: { en: { 'home.title': 'Home' }, hi: { 'home.title': 'होम' } },
};
