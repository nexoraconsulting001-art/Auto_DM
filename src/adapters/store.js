import { createAi } from './ai/index.js';
import { createEmail } from './email/index.js';
import { createRazorpay } from './razorpay/index.js';
import { createShiprocket } from './shiprocket/index.js';
import { createShopify } from './shopify/index.js';
import { createWhatsApp } from './whatsapp/index.js';

/**
 * Everything the store talks to outside (PRD 9), built from config: ctx.providers, beside ctx.meta and ctx.google.
 * Throws at start-up on a bad address. Each adapter has a 10 s timeout on every call, a base URL that tests and local runs
 * point at tools/sim, and refuses a simulator when NODE_ENV=production.
 *
 *   razorpay    one interface, two implementations: `route` (Bhava's account, split settlement) and `partner` (the seller's
 *               own, by Partner OAuth); forMode(mode) picks, and config.paymentMode is the default
 *   shiprocket  rates, AWB, labels, pickup and tracking, on the managed account or the seller's own
 *   shopify     Admin API per connected shop
 *   whatsapp    templates, account details and webhook parsing. Its sendTemplate is the gate's alone. whatsapp.platform is
 *               Bhava's own number, for sellers: the notifications service's alone
 *               Its sendText is the WhatsApp channel's of the compliance gate alone (PRD 6.12)
 *   ai          the model provider behind AI replies (PRD 6.11): answer() and nothing else. 'none' until one is chosen
 *   email       its send is the gate's alone. email.platform is Bhava's own sender, for sellers: the notifications service's alone
 *
 * A message to a shopper goes through ctx.shopperMessages and nowhere else; one to a seller through ctx.notify and nowhere else.
 */
export function createStoreAdapters(config = {}, options = {}) {
  return {
    razorpay: createRazorpay(config, options),
    shiprocket: createShiprocket(config, options),
    shopify: createShopify(config, options),
    whatsapp: createWhatsApp(config, options),
    email: createEmail(config, options),
    ai: createAi(config, options),
  };
}
