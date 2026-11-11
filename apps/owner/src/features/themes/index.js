import { MANAGERS } from '@bhava/app-core/access';
import ThemesScreen from './ThemesScreen.js';

/**
 * Themes. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'themes',
  access: MANAGERS,
  feature: 'theme_presets',
  routeIds: [],
  screens: [{ name: 'index', path: 'themes', title: 'themes.title', component: ThemesScreen }],
  nav: { label: 'themes.title', order: 79 },
  strings: { en: { 'themes.title': 'Themes' }, hi: { 'themes.title': 'थीम' } },
};
