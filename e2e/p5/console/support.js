// Shared by the Phase 5 console browser tests (sign-in, the team, devices, notifications, your account): the real API on
// the built-in database, with Bhava's own WhatsApp number and Google sign-in for sellers on their simulators, on the
// smallest phone the console is built for. Needs a console build (npm run build:console). Nothing here leaves this machine.
//
// Two addresses: the sign-in host (PLATFORM_APP_HOST), which belongs to no business, at app.bhava.localhost (Chromium
// sends *.localhost to loopback itself, and Google's simulator takes it as a redirect address); and the default
// business's own address at 127.0.0.1.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import(). Loading it once with
// plain require first puts it in the cache the app's import() then reads; so everything that reaches the app is
// imported below, after it.
createRequire(import.meta.url)('sharp');

const { accountsApp, sellerCodeFor, typedAccount, otherBusiness, codeSignIn, call, testDevice } = await import('../../../test/p5/accounts/support.js');
const { createGoogle } = await import('../../../tools/sim/google/index.mjs');
const { bindTenant } = await import('../../../src/repos/index.js');
export const { PHONE, SERVER_FAULT, expectHealthy, json, seriousFindings, sideways, toast } = await import('../../p2/console/support.js');

export const APP_HOST = 'app.bhava.localhost';
const SELLER_GOOGLE = 'sim-seller-google-client';

/** A launch option of its own gives a spec file a worker of its own, so the require above runs before anything else tried to import sharp. */
export const ownWorker = (name) => ({ launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', `--disable-features=${name}`] } });

/** A new Indian mobile, as an account holds it (ten digits). Starts 7 or 8, so it never meets the test owner's number. */
export const newPhone = () => `${7 + crypto.randomInt(0, 2)}${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
export const unique = () => crypto.randomBytes(3).toString('hex');

/**
 * The app with its simulators. `passwordLogin` is the PASSWORD_LOGIN setting: off by default here, as everywhere but
 * tests and local runs.
 */
export async function openWorld({ passwordLogin = false } = {}) {
  const google = createGoogle({ sellerClientId: SELLER_GOOGLE });
  await google.start();
  let app;
  try {
    app = await accountsApp({
      overrides: {
        platformAppHost: APP_HOST,
        passwordLogin,
        sellerGoogleClientId: SELLER_GOOGLE,
        sellerGoogleClientSecret: 'sim-seller-google-secret',
        googleKeysBaseUrl: google.url,
        idTokenKeyRefetchMs: 0,
      },
    });
  } catch (err) {
    await google.close();
    throw err;
  }

  const world = {
    app,
    google,
    /** A page on the sign-in host. */
    signInUrl: (path = '/admin') => `http://${APP_HOST}:${app.port}${path}`,
    /** A page on the default business's own address. */
    shopUrl: (path = '/admin') => `http://127.0.0.1:${app.port}${path}`,

    /** Lets earlier codes and limits go, so a number can be sent a code again at once (one browser address sends them all). */
    async freshCodes() {
      await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
      await app.db.platform.query('DELETE FROM rate_limit_hits');
    },

    /** The newest code Bhava's WhatsApp number sent to this phone (ten digits or E.164). */
    code: (phone) => sellerCodeFor(app.whatsapp, phone),
    /** How many messages Bhava's number has sent so far. */
    sentCount: async () => (await app.whatsapp.get('/sent')).sent.length,

    /** A new business with nobody in it yet. */
    business: (name = `Shop ${unique()}`) => otherBusiness(app, name),

    /**
     * Someone with an account in `tenant` (typed in by an owner, proved by their first code sign-in). Returns
     * { phone, userId } with the phone as ten digits.
     */
    async person(tenant, { role = 'owner', permissions = [], name = 'Asha Rao', phone = newPhone() } = {}) {
      const userId = await typedAccount(app, tenant, { name, phone, role, permissions });
      return { phone, userId, name };
    },

    /** A business with its owner: { tenant, owner }. */
    async shop({ name, ownerName = 'Asha Rao' } = {}) {
      const tenant = await world.business(name);
      return { tenant, owner: await world.person(tenant, { role: 'owner', name: ownerName }) };
    },

    /** Products of a business, made straight through its repos. */
    product: (tenant, name) => bindTenant(app.platform, tenant).products.create({ name, price: '100', stock: '', active: 'on' }),

    /** The owner app's session for `phone` (bearer, on the sign-in host): `send(method, path, body)` calls /api/v1 as them. */
    async appSession(phone, { tenantId } = {}) {
      await world.freshCodes();
      const s = await codeSignIn(app, { phone, transport: 'bearer', device: testDevice('Pixel 8'), tenantId, host: APP_HOST });
      s.send = (method, path, body) => call(app, `/api/v1${path}`, { method, body, host: APP_HOST, headers: s.auth });
      return s;
    },

    /** Makes every session's last sign-in or re-auth too old to count, so changes marked fresh ask for a code first. */
    stale: () => app.db.platform.query(`UPDATE sessions SET fresh_until = now() - interval '1 minute'`),

    /** One in-app notification for one account, as ctx.notify hands it out. */
    async notify(tenant, userId, event, { key = unique(), data = {} } = {}) {
      await app.ctx.notify.emit({ event, tenantId: tenant.id, audience: { userId }, key, data, channels: ['inapp'] });
      await app.ctx.notify.drain();
    },

    async close() {
      await app.close();
      await google.close();
    },
  };
  return world;
}

/**
 * Signs in on the console's own sign-in page with a WhatsApp code from Bhava's number, as a seller does, and waits for
 * the console to open. `url` is where the browser starts (a deep link stays where it is).
 */
export async function signInWithCode(page, world, phone, { url = world.signInUrl('/admin') } = {}) {
  await world.freshCodes();
  await page.goto(url);
  await page.getByLabel('WhatsApp number').fill(phone);
  const before = await world.sentCount();
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await expect.poll(world.sentCount).toBeGreaterThan(before);
  await page.getByLabel('6-digit code').fill(await world.code(phone));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeAttached({ timeout: 20_000 });
}

/** Answers the "Confirm it's you" sheet with the re-auth code Bhava's number just sent. */
export async function confirmItsYou(page, world, phone) {
  const sheet = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(sheet.getByLabel('Code from WhatsApp')).toBeVisible();
  await sheet.getByLabel('Code from WhatsApp').fill(await world.code(phone));
  await sheet.getByRole('button', { name: 'Confirm' }).click();
  await expect(sheet).toBeHidden();
}

/** The panel (a titled card) with this heading. */
export const panel = (page, name) => page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });

/** Requests to anywhere but this server and its simulators, and script errors: what would mean the page isn't healthy. */
export function watch(page) {
  const problems = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !url.hostname.endsWith('.localhost') && !['data:', 'blob:'].includes(url.protocol)) problems.push(`outside request: ${url.origin}`);
  });
  page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
  return problems;
}
