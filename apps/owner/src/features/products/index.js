import Package from 'lucide-react-native/icons/package';
import { staffWith } from '@bhava/app-core/access';
import ProductsScreen from './ProductsScreen.js';

/**
 * Products. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'products',
  access: staffWith('catalog'),
  feature: 'catalog',
  routeIds: [],
  screens: [{ name: 'index', path: 'products', title: 'products.title', component: ProductsScreen }],
  nav: { label: 'products.title', order: 20, icon: Package, primary: true },
  strings: { en: { 'products.title': 'Products' }, hi: { 'products.title': 'प्रोडक्ट' } },
};
