import { OWNER_ONLY } from '@bhava/app-core/access';
import AuditLogScreen from './AuditLogScreen.js';

/**
 * Audit log. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'audit-log',
  access: OWNER_ONLY,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'audit-log', title: 'audit-log.title', component: AuditLogScreen }],
  nav: { label: 'audit-log.title', order: 90 },
  strings: { en: { 'audit-log.title': 'Audit log' }, hi: { 'audit-log.title': 'ऑडिट लॉग' } },
};
