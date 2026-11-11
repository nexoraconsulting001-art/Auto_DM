import { MANAGERS } from '@bhava/app-core/access';
import BrandKitScreen from './BrandKitScreen.js';

/**
 * Brand kit. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'brand-kit',
  access: MANAGERS,
  feature: 'brand_kit',
  routeIds: [],
  screens: [{ name: 'index', path: 'brand-kit', title: 'brand-kit.title', component: BrandKitScreen }],
  nav: { label: 'brand-kit.title', order: 80 },
  strings: { en: { 'brand-kit.title': 'Brand kit' }, hi: { 'brand-kit.title': 'ब्रांड किट' } },
};
