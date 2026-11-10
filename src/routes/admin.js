import express from 'express';
import multer from 'multer';
import { ValidationError, parseRupees } from '../util.js';
import { ALLOWED_IMAGE_TYPES } from '../repos/media.js';
import fs from 'node:fs';
import { SEED_FILE, newestReels, seedDemo } from '../../scripts/seed.js';
import crypto from 'node:crypto';
import { SETTING_DEFAULTS } from '../repos/settings.js';
import { currentTenant } from '../tenancy.js';
import { forAccount } from '../instagram.js';
import {
  activityPage, adminLayout, categoriesPage, categoryFormPage, categoryValues, customersPage, dashboardPage,
  orderDetailPage, ordersPage, productFormPage, productValues, productsPage, reelFormPage, reelValues, reelsPage, settingsPage,
} from '../views/admin.js';

const FLASH = {
  saved: 'Saved.',
  created: 'Created.',
  deleted: 'Deleted.',
  reel_saved: 'Reel store saved. Comments with its keyword now get a DM with the store link.',
  reel_removed: 'Reel store removed.',
  status: 'Order updated.',
  demo: 'Demo data loaded: categories and products, plus 3 reel stores. Open “View store” to see them.',
  category_saved: 'Category saved.',
  category_deleted: 'Category deleted. Its products are still in your catalog.',
};

/** Public address of the current business. PUBLIC_BASE_URL applies to the default business only. */
export const baseUrlFor = (req, config) => {
  const t = currentTenant();
  if (config.publicBaseUrl && (!t?.slug || !config.defaultTenant || t.slug === config.defaultTenant)) return config.publicBaseUrl;
  return `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
};

/** Public address of a business when there is no request from its own site (e.g. in a webhook). */
export const tenantBaseUrl = (tenant, config) => {
  if (tenant.slug === config.defaultTenant && config.publicBaseUrl) return config.publicBaseUrl;
  return config.platformDomain ? `https://${tenant.slug}.${config.platformDomain}` : config.publicBaseUrl;
};

const list = (v) => [].concat(v ?? []).filter((x) => x !== '');

export function adminRoutes({ repos, ig, auth, config }) {
  const r = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, ALLOWED_IMAGE_TYPES.includes(file.mimetype)),
  });

  // Only the owner gets past this until staff permissions exist; everyone else is sent to their account page.
  r.use(auth.requireRole('owner'));

  /** The Instagram client for this business's connected account, or null when it has none. */
  async function igClient() {
    const account = await repos.igAccounts.current();
    return account ? forAccount(ig, account) : null;
  }

  // Whether each business's Instagram token works, cached so the dashboard stays fast.
  const igChecks = new Map();
  async function instagramConnected(client) {
    if (!client) return false;
    const business = currentTenant().id;
    const hit = igChecks.get(business);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ok;
    let ok = false;
    try {
      ok = Boolean((await client.getAccount())?.username);
    } catch {
      ok = false;
    }
    igChecks.set(business, { at: Date.now(), ok });
    return ok;
  }

  async function setupChecklist(settings, kit, stats, reels, client) {
    const comments = await repos.activity.count();
    const storeChanged = settings.store_name !== SETTING_DEFAULTS.store_name || Boolean(kit.logoUrl);
    return {
      dismissed: settings.checklist_dismissed === '1',
      steps: [
        { title: 'Connect Instagram', text: 'Connect your Instagram account so comments can be answered with a DM.', done: await instagramConnected(client), href: '/admin/settings', action: 'Check connection' },
        { title: 'Add your store details', text: 'Store name, logo, WhatsApp number and delivery fee.', done: storeChanged, href: '/admin/settings', action: 'Open settings' },
        { title: 'Add products', text: 'Photos, price and MRP. Group them into categories for the shop.', done: stats.products > 0, href: '/admin/products/new', action: 'Add a product' },
        { title: 'Set up your first reel store', text: 'Pick a reel, choose its products and the keyword people comment.', done: reels.length > 0, href: '/admin/reels', action: 'Choose a reel' },
        { title: 'Receive a comment', text: 'Comment your keyword on the reel from another account. The DM shows up in DM activity.', done: comments > 0, href: '/admin/activity', action: 'See DM activity' },
        { title: 'Get your first order', text: 'Share your store link. Orders land in Orders for you to confirm.', done: stats.orders > 0, href: '/', action: 'Open your store' },
      ],
    };
  }

  const page = async (req, res, { title, active, body, error, status = 200 }) => {
    const stats = await repos.stats.dashboard();
    const flash = { ok: FLASH[req.query.ok], error };
    res
      .status(status)
      .type('html')
      .send(String(adminLayout({ title, active, body, csrf: req.csrf, flash, badges: { orders: stats.to_confirm } })));
  };

  // ---- dashboard ----
  r.get('/', async (req, res) => {
    const [stats, reels, orders, activity, settings, kit, client] = await Promise.all([
      repos.stats.dashboard(), repos.reels.list(), repos.orders.list(), repos.activity.list({ limit: 8 }), repos.settings.getAll(), repos.brandKit.get(), igClient(),
    ]);
    const checklist = await setupChecklist(settings, kit, stats, reels, client);
    const warnings = [];
    if (!client) warnings.push('Instagram isn’t connected yet, so DMs can’t be sent.');
    if (config.dryRun) warnings.push('Test mode is on (DRY_RUN=1): DMs are logged, not sent.');
    if (!config.publicBaseUrl) warnings.push(`PUBLIC_BASE_URL isn’t set. DM links will use ${baseUrlFor(req, config)} — set it in .env to be sure.`);
    await page(req, res, { title: 'Dashboard', active: 'dashboard', body: dashboardPage({ stats, reels, orders: orders.slice(0, 6), activity, warnings, checklist, csrf: req.csrf }) });
  });

  r.post('/checklist/dismiss', async (_req, res) => {
    await repos.settings.update({ checklist_dismissed: '1' });
    res.redirect(303, '/admin');
  });

  // ---- products ----
  r.get('/products', async (req, res) => {
    const search = String(req.query.search || '');
    const status = ['active', 'archived', 'featured'].includes(req.query.status) ? req.query.status : 'all';
    const category = Number(req.query.category) || 0;
    const [products, categories] = await Promise.all([repos.products.list({ search, status, category }), repos.categories.list()]);
    await page(req, res, { title: 'Products', active: 'products', body: productsPage({ products, search, status, categories, category }) });
  });

  r.get('/products/new', async (req, res) => {
    const categories = await repos.categories.list();
    await page(req, res, { title: 'Add product', active: 'products', body: productFormPage({ product: null, values: productValues(null), csrf: req.csrf, categories }) });
  });

  const productInput = (body) => ({
    ...body,
    images: list(body.images),
    // Only touch categories when the form had the category section (unticking all boxes sends nothing).
    categoryIds: body.categories_sent ? list(body.categoryIds) : undefined,
  });
  const formValues = (body) => ({ ...productInput(body), active: Boolean(body.active), featured: Boolean(body.featured) });

  r.post('/products', async (req, res) => {
    try {
      const p = await repos.products.create(productInput(req.body));
      res.redirect(303, `/admin/products/${p.id}?ok=created`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const categories = await repos.categories.list();
      await page(req, res, { title: 'Add product', active: 'products', status: 400, error: err.message, body: productFormPage({ product: null, values: formValues(req.body), csrf: req.csrf, categories }) });
    }
  });

  r.get('/products/:id', async (req, res) => {
    const product = await repos.products.get(req.params.id);
    if (!product) return res.redirect('/admin/products');
    const categories = await repos.categories.list();
    await page(req, res, { title: product.name, active: 'products', body: productFormPage({ product, values: productValues(product), csrf: req.csrf, categories }) });
  });

  r.post('/products/:id', async (req, res) => {
    const product = await repos.products.get(req.params.id);
    if (!product) return res.redirect(303, '/admin/products');
    try {
      await repos.products.update(product.id, productInput(req.body));
      res.redirect(303, `/admin/products/${product.id}?ok=saved`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const categories = await repos.categories.list();
      await page(req, res, { title: product.name, active: 'products', status: 400, error: err.message, body: productFormPage({ product, values: formValues(req.body), csrf: req.csrf, categories }) });
    }
  });

  r.post('/products/:id/delete', async (req, res) => {
    const product = await repos.products.get(req.params.id);
    if (!product) return res.redirect(303, '/admin/products');
    try {
      await repos.products.remove(product.id);
      res.redirect(303, '/admin/products?ok=deleted');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const categories = await repos.categories.list();
      await page(req, res, { title: product.name, active: 'products', status: 400, error: err.message, body: productFormPage({ product, values: productValues(product), csrf: req.csrf, categories }) });
    }
  });

  // Image upload from the product form (one file per request, sent by admin.js).
  r.post('/media', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be 5 MB or smaller' : err.message });
      if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG, WebP or GIF image' });
      const id = await repos.media.save(req.file.buffer, req.file.mimetype);
      res.status(201).json({ url: `/media/${id}` });
    });
  });

  // ---- categories ----
  r.get('/categories', async (req, res) => {
    await page(req, res, { title: 'Categories', active: 'categories', body: categoriesPage({ categories: await repos.categories.list() }) });
  });

  async function categoryView(req, res, { category, values, error, status } = {}) {
    const products = category ? await repos.products.list({ category: category.id }) : [];
    await page(req, res, {
      title: category ? category.name : 'Add category', active: 'categories', error, status,
      body: categoryFormPage({ category, values: values || categoryValues(category), csrf: req.csrf, products }),
    });
  }

  r.get('/categories/new', async (req, res) => {
    const all = await repos.categories.list();
    const position = all.length ? Math.max(...all.map((c) => c.position)) + 1 : 1;
    await categoryView(req, res, { values: { ...categoryValues(null), position } });
  });

  r.get('/categories/:id', async (req, res) => {
    const category = await repos.categories.get(req.params.id);
    if (!category) return res.redirect('/admin/categories');
    await categoryView(req, res, { category });
  });

  for (const path of ['/categories', '/categories/:id']) {
    r.post(path, async (req, res) => {
      const category = req.params.id ? await repos.categories.get(req.params.id) : null;
      if (req.params.id && !category) return res.redirect(303, '/admin/categories');
      try {
        const saved = await repos.categories.save(category?.id ?? null, req.body);
        res.redirect(303, `/admin/categories/${saved.id}?ok=category_saved`);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        await categoryView(req, res, { category, values: { ...req.body, visible: Boolean(req.body.visible) }, error: err.message, status: 400 });
      }
    });
  }

  r.post('/categories/:id/delete', async (req, res) => {
    await repos.categories.remove(req.params.id);
    res.redirect(303, '/admin/categories?ok=category_deleted');
  });

  // ---- customers ----
  async function customersView(req, res, resetFor = null) {
    const search = String(req.query.search || '');
    const customers = await repos.users.listCustomers({ search });
    await page(req, res, { title: 'Customers', active: 'customers', body: customersPage({ customers, search, csrf: req.csrf, resetFor }) });
  }

  r.get('/customers', (req, res) => customersView(req, res));

  // Forgot-password flow without SMS: the owner sets a fresh password and sends it on WhatsApp.
  r.post('/customers/:id/reset', async (req, res) => {
    const user = await repos.users.get(req.params.id);
    if (!user || user.role !== 'customer') return res.redirect(303, '/admin/customers');
    const password = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
    await repos.users.setPassword(user.id, password);
    res.set('Cache-Control', 'no-store');
    await customersView(req, res, { name: user.name, phone: user.phone, password });
  });

  // ---- reels ----
  r.get('/reels', async (req, res) => {
    let posts = [];
    let postsError = '';
    const client = await igClient();
    try {
      if (client) posts = (await client.listMedia(50)).data || [];
      else postsError = 'Connect your Instagram account to see your reels here.';
    } catch (err) {
      postsError = err.message;
    }
    const reels = await repos.reels.list();
    await page(req, res, { title: 'Reels', active: 'reels', body: reelsPage({ posts, postsError, reels }) });
  });

  async function reelEditor(req, res, { values, error, status }) {
    const mediaId = String(req.params.id);
    const reel = await repos.reels.get(mediaId);
    let post = null;
    try {
      post = (await (await igClient())?.getMedia(mediaId)) ?? null;
    } catch {
      // Instagram unreachable or post deleted: edit with what we have stored.
    }
    if (!reel && !post) return res.redirect(303, '/admin/reels');
    const products = await repos.products.list();
    await page(req, res, {
      title: 'Reel store', active: 'reels', status, error,
      body: reelFormPage({ mediaId, post, reel, products, values: values || reelValues(reel, post), baseUrl: baseUrlFor(req, config), csrf: req.csrf }),
    });
  }

  r.get('/reels/:id', (req, res) => reelEditor(req, res, {}));

  r.post('/reels/:id', async (req, res) => {
    const input = { ...req.body, productIds: list(req.body.productIds) };
    try {
      await repos.reels.save(req.params.id, input);
      res.redirect(303, `/admin/reels/${req.params.id}?ok=reel_saved`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      await reelEditor(req, res, { values: { ...input, active: Boolean(req.body.active) }, error: err.message, status: 400 });
    }
  });

  r.post('/reels/:id/delete', async (req, res) => {
    await repos.reels.remove(req.params.id);
    res.redirect(303, '/admin/reels?ok=reel_removed');
  });

  // ---- orders ----
  r.get('/orders', async (req, res) => {
    const status = String(req.query.status || '');
    const search = String(req.query.search || '');
    const orders = await repos.orders.list({ status, search });
    await page(req, res, { title: 'Orders', active: 'orders', body: ordersPage({ orders, status, search }) });
  });

  async function orderView(req, res, { error, status } = {}) {
    const order = await repos.orders.get(req.params.id);
    if (!order) return res.redirect(303, '/admin/orders');
    const reel = order.reel_id ? await repos.reels.get(order.reel_id) : null;
    const settings = await repos.settings.getAll();
    await page(req, res, {
      title: order.order_number, active: 'orders', error, status,
      body: orderDetailPage({ order, reel, csrf: req.csrf, storeName: settings.store_name }),
    });
  }

  r.get('/orders/:id', (req, res) => orderView(req, res));

  r.post('/orders/:id/status', async (req, res) => {
    try {
      await repos.orders.setStatus(req.params.id, req.body.status, String(req.body.notes ?? '').slice(0, 1000));
      res.redirect(303, `/admin/orders/${req.params.id}?ok=status`);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      await orderView(req, res, { error: err.message, status: 400 });
    }
  });

  // ---- activity ----
  r.get('/activity', async (req, res) => {
    const rows = await repos.activity.list({ limit: 200 });
    await page(req, res, { title: 'DM activity', active: 'activity', body: activityPage({ rows }) });
  });

  // ---- settings ----
  async function settingsView(req, res, { error, status } = {}) {
    const [saved, kit, client] = await Promise.all([repos.settings.getAll(), repos.brandKit.get(), igClient()]);
    const settings = { ...saved, accent_color: kit.colors.accent, logo_url: kit.logoUrl };
    const connection = {
      baseUrl: baseUrlFor(req, config),
      baseUrlFromEnv: Boolean(config.publicBaseUrl),
      dryRun: config.dryRun,
      oneDmPerUser: config.oneDmPerUser,
      database: config.databaseUrl ? 'Postgres (DATABASE_URL)' : 'Built-in database in data/pgdata',
    };
    try {
      connection.account = client ? await client.getAccount() : null;
      if (!client) connection.error = 'Instagram isn’t connected yet';
    } catch (err) {
      connection.error = err.message;
    }
    await page(req, res, { title: 'Settings', active: 'settings', error, status, body: settingsPage({ settings, connection, csrf: req.csrf }) });
  }

  r.get('/settings', (req, res) => settingsView(req, res));

  r.post('/settings', async (req, res) => {
    try {
      const b = req.body;
      if (!String(b.store_name || '').trim()) throw new ValidationError('Store name is required');
      if (b.logo_url && !/^https?:\/\//i.test(b.logo_url)) throw new ValidationError('Logo link must start with http:// or https://');
      await repos.brandKit.save({
        logoUrl: b.logo_url ?? '',
        ...(/^#[0-9a-f]{6}$/i.test(b.accent_color || '') ? { colors: { accent: b.accent_color } } : {}),
      });
      await repos.settings.update({
        store_name: b.store_name.trim(), tagline: b.tagline?.trim(),
        instagram_handle: String(b.instagram_handle || '').trim().replace(/^@/, ''),
        shipping_fee_paise: parseRupees(b.shipping_fee, 'Delivery fee') ?? 0,
        free_shipping_above_paise: parseRupees(b.free_shipping_above, 'Free delivery amount') ?? 0,
        upi_id: b.upi_id?.trim() || 'demo@upi', upi_payee: b.upi_payee?.trim(),
        support_whatsapp: String(b.support_whatsapp || '').replace(/[^\d]/g, ''), support_email: b.support_email?.trim(),
        ...Object.fromEntries(
          ['hero_kicker', 'hero_title', 'hero_subtitle', 'trust_points', 'bulk_title', 'bulk_text', 'about_text', 'gstin']
            .filter((k) => k in b).map((k) => [k, String(b[k]).trim().slice(0, 4000)]),
        ),
      });
      res.redirect(303, '/admin/settings?ok=saved');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      await settingsView(req, res, { error: err.message, status: 400 });
    }
  });

  // Loads seed/mehtamart.json into the 3 newest reels (same as `npm run seed`, but inside the running server).
  r.post('/demo-data', async (req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      const client = await igClient();
      if (!client) throw new ValidationError('Connect your Instagram account first: demo data goes on your newest reels.');
      const reels = await newestReels(client, data.reels.length);
      if (reels.length < data.reels.length) {
        throw new ValidationError(`Found only ${reels.length} reel(s) on your Instagram account. Demo data needs ${data.reels.length}.`);
      }
      await seedDemo({ repos }, data, reels);
      res.redirect(303, '/admin/reels?ok=demo');
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : `Couldn’t load demo data: ${err.message}`;
      await settingsView(req, res, { error: message, status: 400 });
    }
  });

  return r;
}
