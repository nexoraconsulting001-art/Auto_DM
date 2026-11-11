import { staffWith } from '@bhava/app-core/access';
import AiRepliesScreen from './AiRepliesScreen.js';

/**
 * AI replies. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'ai-replies',
  access: staffWith('automations'),
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'ai-replies', title: 'ai-replies.title', component: AiRepliesScreen }],
  nav: null,
  strings: { en: { 'ai-replies.title': 'AI replies' }, hi: { 'ai-replies.title': 'AI जवाब' } },
};
