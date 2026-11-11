import House from 'lucide-react-native/icons/house';
import { SIGNED_IN } from '@bhava/app-core/access';
import HomeScreen from './HomeScreen.js';

/**
 * Home. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'home',
  access: SIGNED_IN,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: '', title: 'home.title', component: HomeScreen }],
  nav: { label: 'home.title', order: 0, icon: House, primary: true },
  strings: { en: { 'home.title': 'Home' }, hi: { 'home.title': 'होम' } },
};
