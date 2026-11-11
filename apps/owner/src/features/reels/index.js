import Clapperboard from 'lucide-react-native/icons/clapperboard';
import { staffWith } from '@bhava/app-core/access';
import ReelsScreen from './ReelsScreen.js';

/**
 * Reels. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'reels',
  access: staffWith('automations'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'reels', title: 'reels.title', component: ReelsScreen }],
  nav: { label: 'reels.title', order: 30, icon: Clapperboard, primary: true },
  strings: { en: { 'reels.title': 'Reels' }, hi: { 'reels.title': 'रील' } },
};
