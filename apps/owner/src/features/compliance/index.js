import { staffWith } from '@bhava/app-core/access';
import ComplianceScreen from './ComplianceScreen.js';

/**
 * Sending rules. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'compliance',
  access: staffWith('automations'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'compliance', title: 'compliance.title', component: ComplianceScreen }],
  nav: { label: 'compliance.title', order: 64 },
  strings: { en: { 'compliance.title': 'Sending rules' }, hi: { 'compliance.title': 'भेजने के नियम' } },
};
