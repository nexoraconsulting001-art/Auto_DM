// Shared by the Platform Console browser tests (PRD 5.5 to 5.10, 5.12, 5.17, 5.20, 6.11, 6.12): the real app on the platform host, its
// real database and its simulators, with the console built fresh into a temporary folder, on the smallest phone it is built for.
// The browser reaches the platform host as console.bhava.localhost (Chromium sends *.localhost to loopback itself) and every other
// address is swallowed by the dead proxy in playwright.config.mjs, so nothing here leaves this machine.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { expect } from '@playwright/test';

// The app runs inside Playwright's worker, whose module loader fails on first import() of these packages: load them once with
// require so the app's own import() reads them from the cache, and only then import anything that reaches the app.
const require = createRequire(import.meta.url);
require('sharp');
require('semver');

const { openBillingWorld, shopOn, grantService, totp, sql, one, hit } = await import('../../../test/p7/spec-p7/support.js');
const { buildConsole } = await import('../../../test/p7/platform-ui/support.js');
export { PHONE, expectHealthy, json, seriousFindings, sideways, toast } from '../../p2/console/support.js';
export { grantService, shopOn, sql, one, totp, hit };

export const HOST = 'console.bhava.localhost';
export const ownWorker = (name) => ({ launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', `--disable-features=${name}`] } });

/** The app on the platform host with the console built into a folder of its own. */
export async function openConsoleWorld() {
  const dir = buildConsole();
  const world = await openBillingWorld({ overrides: { platformConsoleDir: dir, platformHost: HOST, passwordLogin: true } });
  const close = world.close;
  const url = (path = '/') => `http://${HOST}:${world.port}/console${path}`;
  const consoleWorld = Object.assign(world, {
    consoleUrl: url,
    async close() {
      await close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    /** A signed-in console session for a person of `role`, as a cookie for the browser. */
    async operator(role = 'super_admin') {
      const email = `op${Math.random().toString(36).slice(2, 8)}@team.example`;
      await world.platform.platformUsers.create({ email, password: 'console-pass-1', role, name: 'Operator' });
      const res = await hit(world, '/login', { host: HOST, method: 'POST', body: { email, password: 'console-pass-1' } });
      if (res.status !== 200) throw new Error(`Console sign-in answered ${res.status}: ${res.text.slice(0, 120)}`);
      const cookie = String(res.headers['set-cookie'][0]).split(';')[0];
      const at = cookie.indexOf('=');
      return { email, role, cookie, cookieName: cookie.slice(0, at), value: cookie.slice(at + 1) };
    },
  });
  return consoleWorld;
}

/** Gives the browser's context this person's session. */
export async function signedIn(context, world, operator) {
  await context.addCookies([{ name: operator.cookieName, value: operator.value, url: `http://${HOST}:${world.port}` }]);
}

/** Every request the page made to anywhere but the platform host, and every script error: what would mean the page is not healthy. */
export function watch(page, world) {
  const problems = [];
  page.on('request', (request) => {
    const url = request.url();
    if (request.resourceType() === 'image' && url.startsWith('https:')) return;
    if (!url.startsWith(`http://${HOST}:${world.port}`) && !url.startsWith('data:') && !url.startsWith('blob:')) problems.push(`outside request: ${url}`);
  });
  page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
  return problems;
}

/** Answers a platform route in the browser instead of the server: a refusal, a fault, an empty list, or a request that never ends. */
export async function answer(page, method, path, reply) {
  await page.route(`**${path}*`, async (route) => {
    const request = route.request();
    if (request.method() !== method || !new URL(request.url()).pathname.endsWith(path.split('?')[0])) return route.fallback();
    return reply === 'hang' ? undefined : route.fulfill(reply);
  });
}

export const refusal = (status, error, code = 'forbidden') => ({ status, contentType: 'application/json', body: JSON.stringify({ error, code }) });

/** The dialog that is open, if any. */
export const sheet = (page, name) => page.getByRole('dialog', { name });

/** Types a reason into the open sheet and presses its button. */
export async function submitWithReason(page, name, button, reason) {
  const dialog = sheet(page, name);
  await dialog.getByLabel(/Reason|What needs to change|What was done|What changed/).fill(reason);
  await dialog.getByRole('button', { name: button, exact: true }).click();
}

export async function expectNoSidewaysScroll(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}
