// Shared by the Phase 1 console browser tests: the real API and worker, with the Meta simulator behind them. Needs a console build.
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

export const PHONE = { width: 360, height: 740 };
export const SLUG = 'console-p1';

export const seriousFindings = async (page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
export const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A phone-sized page that doesn't scroll sideways and has no serious accessibility problem. */
export async function expectHealthy(page) {
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(await seriousFindings(page)).toEqual([]);
}

export async function open(page, world, person, path = '') {
  await page.goto(`${world.base}/admin${path}`);
  await page.getByLabel('Mobile number').fill(person.phone);
  await page.getByLabel('Password').fill(person.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
}

export const toast = (page, text) => page.locator('.toast-area').getByText(text);
export const dialogButton = (page, name) => page.getByRole('dialog').getByRole('button', { name, exact: true });
