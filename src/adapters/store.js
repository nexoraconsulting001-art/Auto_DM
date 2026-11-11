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
 *   whatsapp    templates, account details and webhook parsing. Its sendTemplate is the gate's alone
 *   email       its send is the gate's alone
 *
 * A message to a shopper goes through ctx.shopperMessages and nowhere else.
 */
export function createStoreAdapters(config = {}, options = {}) {
  return {
    razorpay: createRazorpay(config, options),
    shiprocket: createShiprocket(config, options),
    shopify: createShopify(config, options),
    whatsapp: createWhatsApp(config, options),
    email: createEmail(config, options),
  };
}
