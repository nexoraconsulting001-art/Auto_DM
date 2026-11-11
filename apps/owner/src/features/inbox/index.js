import { staffWith } from '@bhava/app-core/access';
import InboxScreen from './InboxScreen.js';

/**
 * Inbox. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'inbox',
  access: staffWith('inbox'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'inbox', title: 'inbox.title', component: InboxScreen }],
  nav: { label: 'inbox.title', order: 32 },
  strings: { en: { 'inbox.title': 'Inbox' }, hi: { 'inbox.title': 'इनबॉक्स' } },
};
