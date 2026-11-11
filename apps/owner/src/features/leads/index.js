import { staffWith } from '@bhava/app-core/access';
import LeadsScreen from './LeadsScreen.js';

/**
 * Leads. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'leads',
  access: staffWith('customers'),
  feature: 'lead_form',
  routeIds: [],
  screens: [{ name: 'index', path: 'leads', title: 'leads.title', component: LeadsScreen }],
  nav: { label: 'leads.title', order: 51 },
  strings: { en: { 'leads.title': 'Leads' }, hi: { 'leads.title': 'लीड' } },
};
