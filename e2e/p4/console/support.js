// Shared by the Phase 4 console browser tests: the real API and worker with every store simulator behind them (Razorpay,
// Shiprocket, WhatsApp, mail, Google, Shopify, Meta and outside sites), on the smallest phone the console is built for. Needs a
// console build (npm run build:console). Nothing here leaves this machine.
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(). Loading it once with plain
// require first puts it in the cache the app's import() then reads.
createRequire(import.meta.url)('sharp');

export { NOT_BUILT, PHONE, SERVER_FAULT, expectHealthy, json, open, seriousFindings, sideways, toast, watch } from '../../p2/console/support.js';
export { ownWorker, panel, settled } from '../../p3/console/support.js';

/** A line of a checkout: one of `product`, no option. */
export const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

/** The API's refusal for a feature the plan lacks, as the Phase 4 modules send it. */
export const planRefusal = (error) => ({ status: 403, contentType: 'application/json', body: JSON.stringify({ error, code: 'forbidden', reason: 'plan' }) });

/** Waits until the database says `check(row)` for the order with this number. */
export async function orderBecomes(shop, number, check) {
  await expect.poll(async () => check(await shop.order(number)), { timeout: 20_000 }).toBe(true);
  return shop.order(number);
}
