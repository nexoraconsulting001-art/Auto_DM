import { MANAGERS } from '@bhava/app-core/access';
import ShopifyScreen from './ShopifyScreen.js';

/**
 * Shopify. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'shopify',
  access: MANAGERS,
  feature: 'shopify.sync',
  routeIds: [],
  screens: [{ name: 'index', path: 'shopify', title: 'shopify.title', component: ShopifyScreen }],
  nav: { label: 'shopify.title', order: 74 },
  strings: { en: { 'shopify.title': 'Shopify' }, hi: { 'shopify.title': 'Shopify' } },
};
