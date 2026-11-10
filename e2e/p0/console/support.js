// Shared by the console's browser tests. Needs a build: the gate makes one, or run npm run build:console.
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { OWNER, fakeIg, startApp } from '../../../test/helpers.js';
import { withConsoleApi } from '../../../test/p0/console-port/support/console-api.js';

/** The smallest phone the console is built for. */
export const PHONE = { width: 360, height: 740 };

// A real 1x1 PNG, so the upload goes through the same checks as a photo.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export const startConsoleApp = (options = {}) => startApp({ overrides: { adminUi: 'console' }, modules: withConsoleApi(), ...options });

/** An Instagram account with no posts on it. */
export const noPostsIg = () => ({ ...fakeIg(), listMedia: async () => ({ data: [] }) });

export async function signIn(page, { phone = OWNER.phone, password = OWNER.password } = {}) {
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Opens a page of the console, signing in on the way. */
export async function open(page, app, path = '', credentials) {
  await page.goto(`${app.base}/admin${path}`);
  await signIn(page, credentials);
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
}

export const seriousFindings = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);

export const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Everything that would mean the page isn't healthy: outside requests, script errors, console errors. */
export function watch(page, app) {
  const problems = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(app.base) && !request.url().startsWith('data:') && !request.url().startsWith('blob:')) problems.push(`outside request: ${request.url()}`);
  });
  page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/401|Unauthorized/.test(message.text())) problems.push(`console error: ${message.text()}`);
  });
  return problems;
}

export const status = (page, text) => page.getByRole('status').filter({ hasText: text });

export async function goToMore(page, name) {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('link', { name }).click();
}

export const placeOrder = (app, { productId, name = 'Asha K', phone = '9876543210', qty = 1 }) => app.repos.orders.create({
  items: [{ productId, qty }],
  customer: { name, phone, address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' },
}, { shipping_fee_paise: '4900', free_shipping_above_paise: '99900', store_name: 'Test store' });
