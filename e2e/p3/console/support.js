// Shared by the Phase 3 console browser tests: the real API and worker with the Meta, website and Shopify simulators behind them, on the
// smallest phone the console is built for. Needs a console build (npm run build:console).
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import() (a circular require inside one of its
// dependencies). Loading it once with plain require first puts it in the cache the app's import() then reads.
createRequire(import.meta.url)('sharp');

export { NOT_BUILT, PHONE, SERVER_FAULT, expectHealthy, json, open, seriousFindings, sideways, toast, watch } from '../../p2/console/support.js';

/** A launch option of its own gives a spec file a worker of its own, so the require above runs before anything else has tried to import sharp. */
export const ownWorker = (name) => ({ launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', `--disable-features=${name}`] } });

/** The API's refusal for a feature the plan lacks, as the server sends it. */
export const planRefusal = (error) => ({ status: 403, contentType: 'application/json', body: JSON.stringify({ error, code: 'forbidden', reason: 'plan.not_included' }) });

/** The panel (a titled card) with this heading. */
export const panel = (page, name) => page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });

/** Every call the console made to the API while `action` ran, as "METHOD /path". */
export async function callsDuring(page, action) {
  const calls = [];
  const note = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/')) calls.push(`${request.method()} ${url.pathname.slice('/api/v1'.length)}`);
  };
  page.on('request', note);
  try {
    await action();
  } finally {
    page.off('request', note);
  }
  return calls;
}

/** Waits until nothing is loading on the screen. */
export async function settled(page) {
  await expect(page.locator('.spinner')).toHaveCount(0);
}
