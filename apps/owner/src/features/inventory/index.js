import { staffWith } from '@bhava/app-core/access';
import InventoryScreen from './InventoryScreen.js';

/**
 * Inventory. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'inventory',
  access: staffWith('catalog'),
  feature: 'store.inventory',
  routeIds: [],
  screens: [{ name: 'index', path: 'inventory', title: 'inventory.title', component: InventoryScreen }],
  nav: { label: 'inventory.title', order: 24 },
  strings: { en: { 'inventory.title': 'Inventory' }, hi: { 'inventory.title': 'स्टॉक' } },
};
