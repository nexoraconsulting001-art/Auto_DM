import { MANAGERS } from '@bhava/app-core/access';
import WhatsappScreen from './WhatsappScreen.js';

/**
 * WhatsApp. Built in a later phase: no menu entry until then. Whoever builds this lists every API route id and console page it covers
 * in `routeIds`, adds its screens, and removes those ids from tools/parity-pending.json. The format is in ../index.js.
 */
export default {
  name: 'whatsapp',
  access: MANAGERS,
  feature: null,
  routeIds: [],
  screens: [{ name: 'index', path: 'whatsapp', title: 'whatsapp.title', component: WhatsappScreen }],
  nav: null,
  strings: { en: { 'whatsapp.title': 'WhatsApp' }, hi: { 'whatsapp.title': 'WhatsApp' } },
};
