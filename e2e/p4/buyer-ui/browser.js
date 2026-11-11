// Checks every buyer-ui browser test makes on each screen a shopper sees: the accessibility rules (axe: WCAG 2.1 A and AA,
// and 2.2 AA target size), nothing scrolling sideways at phone width, and no platform name in anything shown or read
// aloud. Shared by the specs in this folder.
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { PLATFORM_NAME, visibleTextInPage } from '../../../test/p4/buyer-ui/support.js';

/** The phone a shopper taps an Instagram link on: Instagram's in-app browser, 360 px wide. */
export const PHONE = Object.freeze({ width: 360, height: 740 });

// WCAG 2.1 A and AA, and 2.2 AA's target size (24 px, or that much clear space around a smaller target).
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Every axe violation of WCAG 2.1 A and AA (and 2.2 target size) on the page as it is now, as "rule (impact): where" lines. */
export async function axeFindings(page, { exclude = [] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(WCAG);
  for (const selector of exclude) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  return violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(' | ')}`);
}

/**
 * The screen as a shopper meets it: accessible, the seller's brand only, and nothing wider than the phone. Soft checks: the
 * journey carries on, and the test fails at its end with every screen's findings together.
 */
export async function checkScreen(page, what, { axe = true } = {}) {
  if (axe) expect.soft(await axeFindings(page), `${what}: accessibility (axe, WCAG 2.1 AA and 2.2 target size)`).toEqual([]);
  const shown = await page.evaluate(visibleTextInPage);
  expect.soft(shown.match(PLATFORM_NAME)?.[0] ?? null, `${what}: the platform's name is shown or read aloud`).toBeNull();
  expect.soft(PLATFORM_NAME.test(await page.content()), `${what}: the platform's name is in the page source`).toBe(false);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect.soft(sideways, `${what}: the page scrolls sideways at phone width`).toBeLessThanOrEqual(0);
}

/**
 * Answers the payment gateway's script, which a real phone would load from the gateway, with a stand-in that records the
 * options it was opened with in window.__gateway and hands them to onOpen(orderId, options), whose answer (the gateway's
 * signed result, or null) goes to the page's handler. Every other outside request (fonts) gets an empty answer.
 */
export async function standInGateway(page, { onOpen } = {}) {
  const outside = [];
  if (onOpen) await page.exposeFunction('__gatewayPaid', onOpen);
  await page.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), async (route) => {
    const url = route.request().url();
    outside.push(url);
    if (/checkout\.razorpay\.com\//.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: `window.Razorpay = function (o) {
  this.on = function (name, fn) { (this._on = this._on || {})[name] = fn; };
  this.open = function () {
    window.__gateway = { key: o.key, order_id: o.order_id, amount: o.amount, currency: o.currency, name: o.name, description: o.description, image: o.image, prefill: o.prefill, theme: o.theme };
    if (typeof window.__gatewayPaid === 'function') window.__gatewayPaid(o.order_id, window.__gateway).then(function (r) { if (r) o.handler(r); });
  };
};`,
      });
    }
    return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  return outside;
}
