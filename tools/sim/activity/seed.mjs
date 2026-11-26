/**
 * Loads one sample business the way its owner would have set it up (Phase 8, Q-01): through the seller API on the business's
 * own address, signed in as its owner, and through the repos an operator's scripts use (scripts/tenant.js, scripts/seed.js).
 * Every item has a natural key (a slug, a name, a code, a made-up media id), so a second run finds each one and changes nothing.
 *
 *   seedBusiness(world, { key, seed, catalogue }) -> { key, tenantId, slug, host, token, owner, created, reused, products, reels, ... }
 *
 * Nothing is copied from one business to another: each call starts from its own seed file, inside its own tenant.
 * Credentials are made here, kept in memory and never printed or written (the owner's password is new on every run).
 */
import crypto from 'node:crypto';
import { bindTenant } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { ACCOUNT_TYPES } from '../../../src/contracts/accounts.js';
import { png } from '../sites/png.mjs';

export class SeedError extends Error {}

/** A control call to a simulator that may already have what it is asked to make (a second run in the same process). */
const once = async (call) => {
  try {
    return await call();
  } catch (err) {
    if (/already exists/.test(String(err?.message ?? err))) return null;
    throw err;
  }
};

const SETTINGS_API = new Map([
  ['store_name', 'storeName'], ['tagline', 'tagline'], ['instagram_handle', 'instagramHandle'], ['support_whatsapp', 'supportWhatsapp'],
  ['support_email', 'supportEmail'], ['hero_kicker', 'heroKicker'], ['hero_title', 'heroTitle'], ['hero_subtitle', 'heroSubtitle'],
  ['trust_points', 'trustPoints'], ['bulk_title', 'bulkTitle'], ['bulk_text', 'bulkText'], ['about_text', 'aboutText'], ['gstin', 'gstin'],
]);

const MEDIA_TYPE = { reel: 'REELS', post: 'FEED', story: 'STORY' };

/**
 * A seller's session on one business's own address: `session` is { token, login() }, and a refused token (a session ages like
 * everything else when time passes) signs in again once. So does a route marked fresh that answers `reauth_required`: a new
 * sign-in starts fresh, which is what a seller in the console does when asked "Confirm it's you". Answers { status, data, text }; throws SeedError on anything outside `ok`.
 */
export function sellerApi(world, host, session) {
  const call = async (method, path, body, { ok = [200, 201, 202, 204], allow = [] } = {}) => {
    let res = await world.hit(`/api/v1${path}`, { host, method, token: session.token, body });
    if ((res.status === 401 || (res.status === 403 && res.data?.code === 'reauth_required')) && session.login) {
      session.token = await session.login();
      res = await world.hit(`/api/v1${path}`, { host, method, token: session.token, body });
    }
    if (res.status >= 200 && res.status < 300 && ok.includes(res.status)) return res;
    if (allow.includes(res.status)) return res;
    const reason = String(res.data?.error ?? res.text).replace(/\s+/g, ' ').slice(0, 220);
    throw new SeedError(`${method} ${path} answered ${res.status}: ${reason}`);
  };
  const all = async (path) => {
    const items = [];
    let cursor = '';
    do {
      const res = await call('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      items.push(...(res.data?.items ?? []));
      cursor = res.data?.nextCursor ?? '';
    } while (cursor);
    return items;
  };
  return { call, all, get: (p, o) => call('GET', p, undefined, o), post: (p, b, o) => call('POST', p, b, o), put: (p, b, o) => call('PUT', p, b, o), patch: (p, b, o) => call('PATCH', p, b, o) };
}

/** The product names a reel or a page shows: the ones it names, then the first `fill` of the catalogue not already named. */
export function namesFor(item, catalogue) {
  const names = [...item.products];
  for (const product of catalogue.products) {
    if (names.length >= item.products.length + (item.fill ?? 0)) break;
    if (!names.includes(product.name)) names.push(product.name);
  }
  return names;
}

const tally = () => {
  const created = {};
  const reused = {};
  return { created, reused, made: (kind) => { created[kind] = (created[kind] ?? 0) + 1; }, kept: (kind) => { reused[kind] = (reused[kind] ?? 0) + 1; } };
};

async function ensureTenant(world, seed, count) {
  const { business } = seed;
  if (!ACCOUNT_TYPES.includes(business.accountType)) throw new SeedError('The account type is not one this platform has');
  let tenant = await world.platform.tenants.getBySlug(business.slug);
  if (tenant) count.kept('business');
  else {
    tenant = await world.platform.tenants.create({ slug: business.slug, name: business.name, plan: business.plan });
    count.made('business');
  }
  if ((tenant.account_type ?? 'seller') !== business.accountType) throw new SeedError(`The business already exists as another kind of account than its seed file says`);
  return tenant;
}

async function ensureOwner(world, tenant, owner, count) {
  const repos = bindTenant(world.platform, tenant);
  const existing = await repos.users.findByPhone(owner.phone);
  // A new password every run: it lives only in memory, so nothing needs storing and nothing can leak.
  const password = `${crypto.randomBytes(18).toString('base64url')}Aa1`;
  const user = await repos.users.ensureOwner({ phone: owner.phone, password, name: owner.name });
  if (!user) throw new SeedError('The owner phone is not a valid mobile number');
  count[existing ? 'kept' : 'made']('owner');
  return { repos, password, phone: owner.phone };
}

async function signIn(world, host, who) {
  const res = await world.hit('/api/v1/auth/login', { host, method: 'POST', body: { phone: who.phone, password: who.password } });
  if (res.status !== 201 || !res.data?.token) throw new SeedError(`The owner could not sign in (${res.status})`);
  return res.data.token;
}

/** Connects the made-up Instagram account through the real consent flow, against the Meta simulator. */
async function connectInstagram(world, { api, repos, seed, tenant }) {
  const { igUserId, igUsername } = seed.business;
  const meta = world.sims.meta;
  await repos.igConnect.allowAppRole();
  await once(() => meta.post('/accounts', { igUserId, username: igUsername, subscribedFields: [] }));
  await meta.post('/oauth/next', { igUserId });
  const started = await api.post('/instagram/connect', { returnTo: '/admin/settings' });
  const dialog = await fetch(started.data.authorizeUrl, { redirect: 'manual' });
  const back = dialog.headers.get('location') ? new URL(dialog.headers.get('location')) : null;
  if (!back) throw new SeedError('The Instagram simulator did not answer the consent screen');
  const done = await fetch(`${world.base}${back.pathname}${back.search}`, { redirect: 'manual' });
  let landing = done.headers.get('location') ?? '';
  // D-4: the callback saves nothing. A connect started with the API token (as the owner app does) comes back to the
  // app's scheme with a finish token, and the seller's own session finishes it.
  const next = landing ? new URL(landing, 'http://relative.invalid') : null;
  if (next?.searchParams.get('instagram') === 'finish') {
    const finished = await api.post('/instagram/connect/finish', { finishToken: next.searchParams.get('f') ?? '' });
    landing = `?instagram=${finished.data?.outcome ?? 'failed'}`;
  }
  if (!/instagram=connected/.test(landing)) throw new SeedError(`Connecting the Instagram account did not finish (${landing.replace(/^https?:\/\/[^/]+/, '').slice(0, 80)})`);
  const connection = (await api.get('/instagram/connection')).data;
  if (connection.status !== 'active') throw new SeedError(`The Instagram account is ${connection.status} after connecting`);
  const [gates] = await world.sql('SELECT gate_passed_at FROM compliance_settings WHERE tenant_id = $1', [tenant.id]);
  if (!gates?.gate_passed_at) throw new SeedError('Meta’s release gates did not pass for the sample business');
}

/** Payments, shipping, WhatsApp and consent: the default path, in test mode, against the simulators. */
async function setUpStore(world, { api, seed }, count) {
  const { owner } = seed.business;
  await api.post('/setup/terms', { version: '1' });

  await api.put('/whatsapp-account', { wabaId: `waba-${seed.business.slug}`, phoneNumberId: `ph-${seed.business.slug}`, accessToken: world.sims.whatsapp.token ?? 'sim-whatsapp-token', displayNumber: owner.phone });
  const synced = await api.post('/whatsapp-templates/sync');
  for (const t of synced.data?.items ?? []) await world.sims.whatsapp.post('/templates', { name: t.name, language: t.language, category: t.category, status: 'APPROVED' });
  await api.post('/whatsapp-templates/sync');

  const payment = (await api.get('/payment-account')).data;
  if (payment.kycStatus !== 'verified') {
    await api.post('/payment-account/linked', { legalName: `${owner.name} Traders`, contactName: owner.name, email: owner.email || seed.app.supportEmail, phone: owner.phone, businessType: 'proprietorship' });
    const [row] = await world.sql('SELECT linked_account_id FROM payment_settings WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)', [seed.business.slug]);
    await world.sims.razorpay.post('/accounts/kyc', { id: row.linked_account_id, status: 'activated' });
    const verified = await world.until(async () => (await api.get('/payment-account')).data.kycStatus === 'verified', 8000);
    if (!verified) throw new SeedError('The test-mode payment account did not become verified');
    count.made('paymentAccount');
  } else count.kept('paymentAccount');
  // The activity run pays for about a quarter of its orders at the door (run.mjs), as a real store does: every sample
  // business offers cash on delivery through the same seller call an owner uses. A second run finds it on and changes nothing.
  const options = (await api.get('/payment-settings')).data;
  if (!options.cod) await api.patch('/payment-settings', { cod: true });

  await api.patch('/shipping-settings', { mode: 'managed', pickupName: `${seed.business.name} Dispatch`, pickupPhone: owner.phone.replace(/^\+91/, ''), pickupLine1: '4 Mill Lane', pickupCity: 'Pune', pickupStateCode: '27', pickupPincode: '411002' });
  const registered = await world.until(async () => (await api.get('/shipping-settings')).data.pickupRegistered, 15_000);
  if (!registered) throw new SeedError('The pickup address did not register with the courier simulator');
  const notice = (await api.get('/consent-notice', { allow: [404] })).data;
  if (!notice?.version) {
    await api.post('/consent-notice', { bodyEn: `${seed.business.name} uses your details to deliver your order.`, bodyHi: `${seed.business.name} आपके विवरण का उपयोग आपका ऑर्डर पहुँचाने के लिए करता है।` });
    count.made('consentNotice');
  } else count.kept('consentNotice');
}

async function ensureFeatures(repos, features) {
  for (const feature of features) {
    if (!(await repos.entitlements.can(feature))) await repos.entitlements.setOverride(feature, { enabled: true });
  }
}

async function loadBrandAndSettings({ api, repos, seed }, count) {
  const { brandKit } = seed;
  await api.patch('/brand-kit', { preset: brandKit.preset, colors: brandKit.colors, ...(brandKit.headingFont ? { headingFont: brandKit.headingFont } : {}), ...(brandKit.bodyFont ? { bodyFont: brandKit.bodyFont } : {}), publicReplyVariants: brandKit.publicReplyVariants });
  count.kept('brandKit');
  const current = await repos.settings.getAll();
  const { SETTING_DEFAULTS } = await import('../../../src/repos/settings.js');
  const updates = {};
  for (const [key, value] of Object.entries(seed.settings)) {
    if (!(key in SETTING_DEFAULTS)) throw new SeedError(`The setting "${key}" is not one a store has`);
    if (current[key] === SETTING_DEFAULTS[key] || current[key] === '') updates[key] = value;
  }
  if (Object.keys(updates).length) {
    await repos.settings.update(updates);
    count.made('settings');
  } else count.kept('settings');
}

async function loadCategories({ api, seed, catalogue }, count) {
  const wanted = new Map();
  for (const c of [...catalogue.categories, ...seed.categories]) if (!wanted.has(c.name)) wanted.set(c.name, c);
  const have = new Map((await api.all('/categories')).map((c) => [c.name, c.id]));
  for (const c of wanted.values()) {
    if (have.has(c.name)) { count.kept('category'); continue; }
    const made = await api.post('/categories', { name: c.name, slug: c.slug, description: c.description, imageUrl: c.imageUrl, position: c.position, visible: true });
    have.set(c.name, made.data.id);
    count.made('category');
  }
  return have;
}

/** What a shopper can put in a bag: the product, or one of its variants (a product with options is bought as a variant). */
async function buyable(api, base, p) {
  if (!p.options.length) return { ...base, plain: true, variants: [] };
  const detail = (await api.get(`/products/${base.id}`)).data;
  return { ...base, plain: false, variants: (detail.variants ?? []).filter((v) => v.inStock).map((v) => ({ id: v.id, pricePaise: v.pricePaise })) };
}

async function loadProducts({ api, catalogue }, categoryIds, count) {
  const have = new Map((await api.all('/products?status=all')).map((p) => [p.name, p]));
  const out = new Map();
  for (const p of catalogue.products) {
    const existing = have.get(p.name);
    if (existing) {
      count.kept('product');
      out.set(p.name, await buyable(api, { id: existing.id, pricePaise: existing.pricePaise }, p));
      continue;
    }
    const body = {
      name: p.name,
      description: p.description,
      pricePaise: p.pricePaise,
      images: p.images.slice(0, 6),
      stock: p.stock,
      active: true,
      featured: p.featured,
      categoryIds: p.categories.map((n) => categoryIds.get(n)).filter(Boolean),
      ...(p.mrpPaise !== null ? { mrpPaise: p.mrpPaise } : {}),
      ...(p.options.length ? { options: p.options.map((o) => ({ name: o.name, values: o.values })) } : {}),
      ...(p.variants.length ? { variants: p.variants.map((v) => ({ optionValues: p.options.map((o) => v.options[o.name]), sku: v.sku, pricePaise: v.pricePaise ?? p.pricePaise, mrpPaise: v.mrpPaise ?? null, inStock: v.stock !== 0 })) } : {}),
    };
    const made = await api.post('/products', body);
    out.set(p.name, await buyable(api, { id: made.data.id, pricePaise: p.pricePaise }, p));
    count.made('product');
  }
  return out;
}

/** Media at the Meta simulator, then a landing page per reel (one row serves both: a reel is a page with a post behind it). */
async function loadReelsAndPages({ world, api, seed, catalogue }, categoryIds, productIds, count) {
  const igUserId = seed.business.igUserId;
  const meta = world.sims.meta;
  const idOf = (names) => names.map((n) => productIds.get(n)?.id).filter(Boolean);
  const catsOf = (names) => names.map((n) => categoryIds.get(n)).filter(Boolean);
  const existing = new Map((await api.all('/pages')).map((p) => [p.mediaId, p]));
  const pagesByReel = new Map();
  for (const page of seed.landingPages) if (page.reel && !pagesByReel.has(page.reel)) pagesByReel.set(page.reel, page);

  const targets = seed.reels.map((reel, index) => ({ reel, page: pagesByReel.get(reel.key) ?? null, mediaId: reel.igMediaId, kind: reel.kind, caption: reel.caption, index }));
  seed.landingPages.filter((p) => p.reel === null).forEach((page, i) => {
    targets.push({ reel: null, page, mediaId: `9000300000${String(seed.business.igUserId).slice(-4)}${String(i).padStart(2, '0')}`, kind: page.kind, caption: page.title, index: targets.length });
  });

  const out = [];
  for (const t of targets) {
    await once(() => meta.post('/media', { igUserId, id: t.mediaId, productType: MEDIA_TYPE[t.kind], mediaType: t.kind === 'reel' ? 'VIDEO' : 'IMAGE', caption: t.caption }));
    const source = t.page ?? t.reel;
    const slug = t.page?.slug ?? t.reel.slug;
    const headline = t.page?.title ?? t.reel.headline;
    const names = namesFor(source, catalogue);
    const categories = t.page?.categories?.length ? t.page.categories : (t.reel?.categories ?? []);
    let page = existing.get(t.mediaId);
    if (page) count.kept('page');
    else {
      const made = await api.post('/pages', { kind: t.kind, mediaId: t.mediaId, slug, headline, productIds: idOf(names), categoryIds: catsOf(categories) });
      page = made.data;
      count.made('page');
    }
    out.push({ key: t.reel?.key ?? null, pageSlug: t.page?.slug ?? null, slug: page.slug, mediaId: t.mediaId, kind: t.kind, url: page.url, caption: t.caption });
  }
  return out;
}

async function loadAutomations({ api, seed }, reels, count) {
  const have = new Set((await api.all('/automations')).map((a) => a.name));
  const keywordsByReel = new Map();
  const reelOf = (automation) => reels.find((r) => (automation.reel ? r.key === automation.reel : automation.link.page ? r.pageSlug === automation.link.page : false)) ?? null;
  for (const a of seed.automations) {
    if (have.has(a.name)) { count.kept('automation'); continue; }
    const reel = reelOf(a);
    const page = a.link.type === 'bhava_page' ? reels.find((r) => r.pageSlug === a.link.page) ?? reel : null;
    const linkUrl = a.link.type === 'bhava_page' ? page?.url : a.link.url;
    if (!linkUrl) throw new SeedError(`The automation "${a.name.slice(0, 40)}" has no link to send`);
    let triggers = [];
    if (a.trigger === 'comment') {
      if (!reel) throw new SeedError(`The automation "${a.name.slice(0, 40)}" runs on a post, and names none`);
      triggers = [{ targetType: reel.kind === 'post' ? 'post' : 'reel', mediaId: reel.mediaId }];
    } else if (a.trigger === 'story_reply') triggers = reel?.kind === 'story' ? [{ targetType: 'story', mediaId: reel.mediaId }] : [{ targetType: 'any_story' }];
    else triggers = [{ targetType: 'dm' }];
    const keywords = a.keywords;
    const body = {
      name: a.name,
      triggerType: a.trigger,
      matchMode: keywords.length ? 'keywords' : 'any',
      anyModeAcknowledged: keywords.length === 0,
      keywords,
      linkMode: 'two_tap',
      linkType: a.link.type,
      linkUrl,
      tapButtonTitle: a.buttonText || 'Send me the link',
      triggers,
      variants: [{ label: 'A', body: a.message, buttonTitle: a.buttonText || '' }],
    };
    const made = (await api.post('/automations', body)).data;
    count.made('automation');
    if (a.state !== 'draft') {
      await api.post(`/automations/${made.id}/state`, { state: a.state === 'paused' ? 'live' : a.state });
      if (a.state === 'paused') await api.post(`/automations/${made.id}/state`, { state: 'paused' });
    }
    if (reel && a.trigger === 'comment' && a.state === 'live') keywordsByReel.set(reel.mediaId, [...(keywordsByReel.get(reel.mediaId) ?? []), ...keywords]);
  }
  // Which words work on which post, from the seed alone: what the activity generator comments.
  for (const a of seed.automations) {
    const reel = reelOf(a);
    if (reel && a.trigger === 'comment' && a.state === 'live' && !keywordsByReel.has(reel.mediaId)) keywordsByReel.set(reel.mediaId, a.keywords);
  }
  return keywordsByReel;
}

async function loadFaqAndCoupons({ api, seed }, count) {
  const questions = new Set((await api.all('/faq')).map((f) => f.question));
  for (const f of seed.faq) {
    if (questions.has(f.question)) { count.kept('faq'); continue; }
    await api.post('/faq', { question: f.question, answer: f.answer });
    count.made('faq');
  }
  const codes = new Set((await api.all('/coupons')).map((c) => c.code));
  for (const c of seed.coupons) {
    if (codes.has(c.code)) { count.kept('coupon'); continue; }
    await api.post('/coupons', {
      code: c.code, kind: c.kind, minOrderPaise: c.minOrderPaise, maxUses: c.maxUses, maxUsesPerCustomer: c.maxUsesPerCustomer,
      ...(c.percentBp !== undefined ? { percentBp: c.percentBp } : {}), ...(c.amountPaise !== undefined ? { amountPaise: c.amountPaise } : {}), ...(c.maxDiscountPaise !== undefined ? { maxDiscountPaise: c.maxDiscountPaise } : {}),
    });
    count.made('coupon');
  }
}

async function loadAppConfig({ api, repos, seed, host }, count) {
  const { app } = seed;
  // The seed names no image files, so the app gets plain placeholders in its own colours: invented, solid, and made here.
  const current = (await api.get('/app-publishing')).data;
  const images = {};
  if (!current.iconMediaId) images.iconMediaId = await repos.media.save(png({ width: 1024, height: 1024, color: seed.brandKit.colors.primary ?? '#3B2FC9' }), 'image/png');
  if (!current.splashMediaId) images.splashMediaId = await repos.media.save(png({ width: 1284, height: 1284, color: app.splashBackground }), 'image/png');
  await api.put('/app-publishing', {
    ...images,
    appName: app.appName, shortName: app.shortName, urlScheme: app.urlScheme, androidPackage: app.androidPackage, iosBundleId: app.iosBundleId,
    splashBackground: app.splashBackground, supportEmail: app.supportEmail, shopDomain: host, privacyUrl: `https://${host}/privacy`,
    // Made up from the business's own name: the shape of a Play App Signing fingerprint, belonging to no real key.
    playSigningSha256: [crypto.createHash('sha256').update(`sample:${seed.business.slug}`).digest('hex').toUpperCase().match(/../g).join(':')],
  });
  count.kept('appConfig');
}

/**
 * Sets one sample business up. `business` is an entry of loadShowcase(). Answers what was made and what was already there,
 * and what the activity generator needs: the business's address, an owner session, its products, posts and live words.
 */
export async function seedBusiness(world, business) {
  const { seed, catalogue, key } = business;
  const count = tally();
  const tenant = await ensureTenant(world, seed, count);
  const host = `${seed.business.slug}.${world.config.platformDomain}`;
  const owner = await ensureOwner(world, tenant, seed.business.owner, count);
  const session = { token: '', login: () => signIn(world, host, owner) };
  session.token = await session.login();
  const api = sellerApi(world, host, session);
  const ctx = { world, api, repos: owner.repos, seed, catalogue, tenant, host };

  await ensureFeatures(owner.repos, ['ai_replies', 'app.android']);
  await connectInstagram(world, ctx);
  await setUpStore(world, ctx, count);
  await loadBrandAndSettings(ctx, count);
  const categoryIds = await loadCategories(ctx, count);
  const products = await loadProducts(ctx, categoryIds, count);
  const reels = await loadReelsAndPages(ctx, categoryIds, products, count);
  const keywords = await loadAutomations(ctx, reels, count);
  await loadFaqAndCoupons(ctx, count);
  await loadAppConfig(ctx, count);

  return {
    key, slug: seed.business.slug, tenantId: tenant.id, host, owner: { phone: owner.phone, password: owner.password }, session, api,
    seed, catalogue, productIds: products, reels, keywords, created: count.created, reused: count.reused,
    igUserId: seed.business.igUserId,
  };
}

/** Runs `fn` as the business, for code that needs repos or modules directly. */
export const asBusiness = (world, tenantId, fn) => withTenant({ id: tenantId }, fn);
