import Package from 'lucide-react-native/icons/package';
import { staffWith } from '@bhava/app-core/access';
import ProductsScreen, { CatalogSettingsScreen } from './ProductsScreen.js';
import ProductEditScreen from './ProductEditScreen.js';
import strings from './strings.js';

/**
 * Products (PRD 8.1, 8.2, 8.8): the catalog, a product with its options, variants and photos, and how often imported
 * products are checked again. The console's two product areas (Catalog and the Phase 0 Products page) are the same
 * screens here. This folder also holds what every catalog and analytics screen shares: kit.js (the four states, the
 * source label, photo upload with the web's limits), money.js (paise to rupees, one formatter), upload.js and limits.js.
 */
export default {
  name: 'products',
  access: staffWith('catalog'),
  feature: 'catalog',
  routeIds: [
    'products.list', 'products.create', 'products.get', 'products.update', 'products.remove', 'products.recheck',
    'catalogSettings.get', 'catalogSettings.update', 'media.upload',
    'console:/catalog', 'console:/catalog/new', 'console:/catalog/settings', 'console:/catalog/:id',
    'console:/products', 'console:/products/new', 'console:/products/:id',
  ],
  screens: [
    { name: 'index', path: 'products', title: 'products.title', component: ProductsScreen },
    { name: 'create', path: 'products/new', title: 'products.add', component: ProductEditScreen },
    { name: 'edit', path: 'products/:id', title: 'products.edit', component: ProductEditScreen },
    { name: 'settings', path: 'catalog/settings', title: 'products.settings.title', component: CatalogSettingsScreen },
  ],
  nav: { label: 'products.title', order: 20, icon: Package, primary: true },
  strings,
};
