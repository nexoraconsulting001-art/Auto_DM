// Shared by the catalog and import tests: the whole app on a fresh database with the site simulator standing in for every
// outside website (a Shopify storefront among them), businesses with their own owners and addresses, and the worker's own
// job handlers, drained by the test so a run is deterministic. Nothing here reaches a real site.
import '../../../tools/net-guard.mjs';
import { config as baseConfig } from '../../../src/config.js';
import { MODULES } from '../../../src/modules/index.js';
import { importService, jobHandlers } from '../../../src/modules/imports/index.js';
import { createPlatform } from '../../../src/platform/index.js';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createShopify } from '../../../tools/sim/shopify/index.mjs';
import { createSites } from '../../../tools/sim/sites/index.mjs';
import { TEST_DATA_KEY, startApp } from '../../helpers.js';
import { NEUTRAL, addBusiness, api, hit, need, signIn } from '../../p0/spec-p0/support.js';

export { captureLogs, hit, need } from '../../p0/spec-p0/support.js';

export const STORE = 'plants.example';
let serial = 0;

/**
 * `adapters` are site adapters to register (config.siteAdapters). `overrides` change the app's and the worker's config.
 * Returns the app, the simulators, `addShop()` for a business, and `runJobs()` to do the worker's work now.
 */
export async function openWorld(t, { adapters = [], overrides = {} } = {}) {
  const sites = createSites();
  const shopify = createShopify();
  await sites.start();
  await shopify.start();
  sites.mount(STORE, shopify);
  t.after(() => Promise.all([sites.close(), shopify.close()]));

  const shared = { platformDomain: NEUTRAL, publicBaseUrl: '', defaultTenant: '', safeFetchTransport: sites.transport(), fetchHostGapMs: 0, siteAdapters: adapters, ...overrides };
  const app = await startApp({ overrides: shared });
  t.after(() => app.close());

  // The worker's side: the same database, its own drivers, as src/worker.js builds them.
  const config = { ...baseConfig, storageDriver: 'memory', queueDriver: 'pg', analyticsDriver: 'pg', cacheDriver: 'memory', sessionSecret: 'test-secret', dataKey: TEST_DATA_KEY, ...shared };
  const drivers = createPlatform(config, { db: app.db });
  const repos = createRepos(app.db, { storage: drivers.storage, secrets: drivers.secrets, modules: MODULES });
  const jobCtx = { db: app.db, repos, platform: drivers, config, modules: MODULES };
  const handlers = jobHandlers(jobCtx);

  /** Runs every queued job of this module until nothing is left (a step of an import may queue the next). */
  async function runJobs({ only } = {}) {
    let total = 0;
    for (let round = 0; round < 50; round++) {
      let ran = 0;
      for (const [name, handler] of Object.entries(handlers)) if (!only || only.includes(name)) ran += await drivers.queue.drain(name, handler, { limit: 500 });
      total += ran;
      if (!ran) return total;
    }
    throw new Error('jobs kept queueing more jobs');
  }

  async function addShop({ plan = 't3', name } = {}) {
    const slug = `c${process.pid}x${++serial}`;
    const business = await addBusiness(app, { slug, name: name ?? `Shop ${serial}`, plan });
    const token = await signIn(app, business);
    const bound = bindTenant(repos, business.tenant);
    const tenantId = business.tenant.id;
    // A kept-alive connection the server closed while the worker's jobs ran fails on reuse before the request is sent; ask again.
    const call = (path, options = {}, who = token) => api(app, business, who, path, options).catch((err) => {
      if (err?.code !== 'ECONNRESET') throw err;
      return api(app, business, who, path, options);
    });
    const shop = {
      ...business, tenantId, token, repos: bound,
      inside: (fn) => withTenant(business.tenant, fn),
      sql: (text, params = []) => app.db.platform.query(text, params),
      call,
      json: async (path, options = {}, status = 200) => need(await call(path, options), status, `${options.method ?? 'GET'} ${path}`).json(),
      post: (path, body, status = 201) => shop.json(path, { method: 'POST', body }, status),
      patch: (path, body, status = 200) => shop.json(path, { method: 'PATCH', body }, status),
      /** Uploads a CSV as the console does: multipart, in the field called `file`. */
      async uploadCsv(text, { filename = 'products.csv', type = 'text/csv' } = {}) {
        const form = new FormData();
        form.append('file', new Blob([text], { type }), filename);
        const res = await fetch(`${app.base}/api/v1/imports/csv`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-host': business.host }, body: form });
        return { status: res.status, body: await res.json() };
      },
      products: async (query = '') => (await shop.json(`/products?limit=100${query ? `&${query}` : ''}`)).items,
      job: (id) => shop.json(`/imports/${id}`),
      items: async (id, query = '') => (await shop.json(`/imports/${id}/items?limit=100${query ? `&${query}` : ''}`)).items,
      /** Queues an import through the API, runs the worker, and answers the finished job. */
      async importAndRun(path, body) {
        const queued = await shop.post(path, body, 202);
        await runJobs();
        return shop.job(queued.id);
      },
    };
    return shop;
  }

  return { app, sites, shopify, drivers, repos, jobCtx, handlers, runJobs, addShop, service: importService(jobCtx) };
}

/** A storefront on the simulator with `count` generated products. */
export const fillStore = (shopify, count, extra = {}) => shopify.post('/storefront/generate', { count, ...extra });

/** A CSV file's text from rows of cells, quoted where needed. */
export const csvText = (rows) => rows.map((row) => row.map((cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(',')).join('\n');
