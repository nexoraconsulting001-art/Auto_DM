// Shared by the Phase 2 console browser tests: the real API and worker, with the Meta and Google simulators behind them, on the
// smallest phone the console is built for. Needs a console build (npm run build:console).
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

export const PHONE = { width: 360, height: 740 };

export const SERVER_FAULT = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong on our side. Please try again.', code: 'internal' }) };
export const NOT_BUILT = { status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'This isn’t available yet.', code: 'not_implemented' }) };
export const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

export const seriousFindings = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
export const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A phone-sized page that doesn't scroll sideways and has no serious accessibility problem. */
export async function expectHealthy(page) {
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await seriousFindings(page)).toEqual([]);
}

/** Opens a console page, signing in as `person` on the way. */
export async function open(page, world, person, path = '') {
  await page.goto(`${world.base}/admin${path}`);
  await page.getByLabel('Mobile number').fill(person.phone);
  await page.getByLabel('Password').fill(person.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
}

/**
 * Everything that would mean the page isn't healthy: requests to anywhere but this server (pictures of posts aside: they are Instagram's
 * own thumbnails, shown as Phase 1's screens show them), and script errors.
 */
export function watch(page, world) {
  const problems = [];
  page.on('request', (request) => {
    const url = request.url();
    if (request.resourceType() === 'image') return;
    if (!url.startsWith(world.base) && !url.startsWith('data:') && !url.startsWith('blob:')) problems.push(`outside request: ${url}`);
  });
  page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
  return problems;
}

export const toast = (page, text) => page.locator('.toast-area').getByText(text);
