import { OWNER_ONLY } from '@bhava/app-core/access';
import BillingScreen from './BillingScreen.js';

/**
 * Plan and billing. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'billing',
  access: OWNER_ONLY,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'billing', title: 'billing.title', component: BillingScreen }],
  nav: null,
  strings: { en: { 'billing.title': 'Plan and billing' }, hi: { 'billing.title': 'प्लान और बिलिंग' } },
};
