/**
 * Answers the /api/v1 routes that no real module answers yet, straight from the repos, so the console can be
 * exercised end to end while the admin API is built on its own branch. It steps aside route by route: once a
 * real module answers a route, the real one is what runs and this does nothing for it.
 *
 * Remove it, and the `modules: withConsoleApi()` arguments that use it, once every route has a real handler.
 */
import crypto from 'node:crypto';
import { ApiError } from '../../../../src/contracts/api/index.js';
import { forAccount } from '../../../../src/instagram.js';
import { MODULES } from '../../../../src/modules/index.js';
import { SETTING_DEFAULTS } from '../../../../src/repos/settings.js';
import { baseUrlFor } from '../../../../src/routes/admin.js';

const page = (rows, { cursor, limit = 25 }) => {
  const start = Number(cursor) || 0;
  const end = start + limit;
  return { items: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null };
};
const rupees = (paise) => (paise === null || paise === undefined ? '' : String(paise / 100));

const product = (p) => ({
  id: p.id, name: p.name, slug: p.slug, description: p.description, pricePaise: p.price_paise, mrpPaise: p.mrp_paise, images: p.images,
  optionLabel: p.option_label, optionValues: p.option_values, stock: p.stock, active: p.active, featured: p.featured, createdAt: p.created_at, updatedAt: p.updated_at,
});
const productDetail = (p) => p && { ...product(p), categoryIds: p.category_ids ?? [] };
const productInput = (b) => ({
  name: b.name, description: b.description ?? '', price: rupees(b.pricePaise), mrp: rupees(b.mrpPaise), images: b.images ?? [], option_label: b.optionLabel ?? '',
  option_values: (b.optionValues ?? []).join(', '), stock: b.stock === null || b.stock === undefined ? '' : String(b.stock), active: b.active ?? true, featured: b.featured ?? false, categoryIds: b.categoryIds,
});

const category = (c) => c && { id: c.id, name: c.name, slug: c.slug, imageUrl: c.image_url, description: c.description, position: c.position, visible: c.visible, productCount: c.product_count ?? 0 };

const order = (o) => ({
  id: o.id, orderNumber: o.order_number, status: o.status, customerName: o.customer_name, phone: o.phone, email: o.email, address: o.address, city: o.city, state: o.state, pincode: o.pincode,
  subtotalPaise: o.subtotal_paise, shippingPaise: o.shipping_paise, totalPaise: o.total_paise, reelId: o.reel_id, source: o.source ?? '', notes: o.notes ?? '', createdAt: o.created_at, updatedAt: o.updated_at,
});
const orderDetail = (o) => o && {
  ...order(o),
  items: o.items.map((i) => ({ id: i.id, productId: i.product_id, name: i.name, image: i.image ?? '', pricePaise: i.price_paise, option: i.option_value ?? '', qty: i.qty })),
};

function handlers({ repos, ig, config }) {
  const client = async () => {
    const account = await repos.igAccounts.current();
    return account ? forAccount(ig, account) : null;
  };
  const reel = (r, req) => ({
    id: r.ig_media_id, slug: r.slug, headline: r.headline, keywords: r.keywords, dmMessage: r.dm_message, buttonText: r.button_text, publicReply: r.public_reply, active: r.active,
    permalink: r.permalink ?? '', thumbnailUrl: r.thumbnail_url ?? '', videoUrl: r.video_url ?? '', caption: r.caption ?? '', storeUrl: `${baseUrlFor(req, config)}/r/${r.slug}`, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const reelDetail = (r, req) => r && {
    ...reel(r, req),
    products: r.products.map((p) => ({ id: p.id, name: p.name, pricePaise: p.price_paise, images: p.images, active: p.active, position: p.position })),
  };
  const settings = (s) => ({
    storeName: s.store_name, tagline: s.tagline, instagramHandle: s.instagram_handle, shippingFeePaise: Number(s.shipping_fee_paise), freeShippingAbovePaise: Number(s.free_shipping_above_paise), upiId: s.upi_id, upiPayee: s.upi_payee,
    supportWhatsapp: s.support_whatsapp, supportEmail: s.support_email, heroKicker: s.hero_kicker, heroTitle: s.hero_title, heroSubtitle: s.hero_subtitle, trustPoints: s.trust_points, bulkTitle: s.bulk_title, bulkText: s.bulk_text, aboutText: s.about_text, gstin: s.gstin,
    checklistDismissed: s.checklist_dismissed === '1',
  });
  const SETTING_NAMES = {
    storeName: 'store_name', tagline: 'tagline', instagramHandle: 'instagram_handle', shippingFeePaise: 'shipping_fee_paise', freeShippingAbovePaise: 'free_shipping_above_paise', supportWhatsapp: 'support_whatsapp', supportEmail: 'support_email',
    heroKicker: 'hero_kicker', heroTitle: 'hero_title', heroSubtitle: 'hero_subtitle', trustPoints: 'trust_points', bulkTitle: 'bulk_title', bulkText: 'bulk_text', aboutText: 'about_text', gstin: 'gstin', upiId: 'upi_id', upiPayee: 'upi_payee',
  };
  const saveSettings = async (body) => {
    const values = Object.fromEntries(Object.entries(body).filter(([key]) => SETTING_NAMES[key]).map(([key, value]) => [SETTING_NAMES[key], value]));
    if ('checklistDismissed' in body) values.checklist_dismissed = body.checklistDismissed ? '1' : '';
    await repos.settings.update(values);
    return settings(await repos.settings.getAll());
  };

  return {
    'products.list': async ({ query }) => page((await repos.products.list(query)).map((p) => ({ ...product(p), reelCount: p.reel_count, categoryNames: p.category_names })), query),
    'products.get': async ({ params }) => productDetail(await repos.products.get(params.id)),
    'products.create': async ({ body }) => productDetail(await repos.products.get((await repos.products.create(productInput(body))).id)),
    'products.update': async ({ params, body }) => {
      const current = await repos.products.get(params.id);
      if (!current) return null;
      await repos.products.update(params.id, productInput({ categoryIds: current.category_ids, ...productDetail(current), ...body }));
      return productDetail(await repos.products.get(params.id));
    },
    'products.remove': async ({ params }) => {
      if (!(await repos.products.get(params.id))) throw new ApiError('not_found');
      await repos.products.remove(params.id);
    },

    'categories.list': async ({ query }) => page((await repos.categories.list()).map(category), query),
    'categories.get': async ({ params }) => category(await repos.categories.get(params.id)),
    'categories.create': async ({ body }) => category(await repos.categories.get((await repos.categories.save(null, { name: body.name, slug: body.slug, image_url: body.imageUrl, description: body.description, position: body.position, visible: body.visible ?? true })).id)),
    'categories.update': async ({ params, body }) => {
      const current = category(await repos.categories.get(params.id));
      if (!current) return null;
      const merged = { ...current, ...body };
      await repos.categories.save(params.id, { name: merged.name, slug: merged.slug, image_url: merged.imageUrl, description: merged.description, position: merged.position, visible: merged.visible });
      return category(await repos.categories.get(params.id));
    },
    'categories.remove': async ({ params }) => {
      if (!(await repos.categories.get(params.id))) throw new ApiError('not_found');
      await repos.categories.remove(params.id);
    },

    'reels.list': async ({ query, req }) => page((await repos.reels.list()).map((r) => ({ ...reel(r, req), productCount: r.product_count, dmCount: r.dm_count, visitCount: r.visit_count, orderCount: r.order_count })), query),
    'reels.get': async ({ params, req }) => reelDetail(await repos.reels.get(params.id), req),
    'reels.save': async ({ params, body, req }) => reelDetail(await repos.reels.save(params.id, {
      slug: body.slug, headline: body.headline, keywords: body.keywords.join(','), dm_message: body.dmMessage, button_text: body.buttonText, public_reply: body.publicReply, active: body.active ?? true,
      productIds: body.productIds, permalink: body.permalink, thumbnail_url: body.thumbnailUrl, video_url: body.videoUrl, caption: body.caption,
    }), req),
    'reels.remove': async ({ params }) => {
      if (!(await repos.reels.get(params.id))) throw new ApiError('not_found');
      await repos.reels.remove(params.id);
    },
    'reels.instagramPosts': async ({ query }) => {
      const instagram = await client();
      if (!instagram) return page([], query);
      const configured = new Set((await repos.reels.list()).map((r) => r.ig_media_id));
      const posts = (await instagram.listMedia(query.limit)).data ?? [];
      return page(posts.map((p) => ({ id: p.id, caption: p.caption ?? '', mediaType: p.media_product_type ?? p.media_type ?? '', permalink: p.permalink ?? '', thumbnailUrl: p.thumbnail_url ?? p.media_url ?? '', configured: configured.has(p.id) })), query);
    },

    'orders.list': async ({ query }) => page((await repos.orders.list({ status: query.status ?? '', search: query.search ?? '' })).map((o) => ({ ...order(o), itemCount: o.item_count })), query),
    'orders.get': async ({ params }) => orderDetail(await repos.orders.get(params.id)),
    'orders.setStatus': async ({ params, body }) => {
      if (!(await repos.orders.get(params.id))) return null;
      await repos.orders.setStatus(params.id, body.status, body.notes);
      return orderDetail(await repos.orders.get(params.id));
    },

    'customers.list': async ({ query }) => page((await repos.users.listCustomers({ search: query.search ?? '' })).map((u) => ({
      id: u.id, name: u.name, phone: u.phone, email: u.email ?? '', role: u.role, orderCount: u.order_count, spentPaise: Number(u.spent), createdAt: u.created_at,
    })), query),
    'customers.resetPassword': async ({ params }) => {
      const user = await repos.users.get(params.id);
      if (!user || user.role !== 'customer') return null;
      const temporaryPassword = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
      await repos.users.setPassword(user.id, temporaryPassword);
      return { temporaryPassword };
    },

    'settings.get': async () => settings(await repos.settings.getAll()),
    'settings.update': ({ body }) => saveSettings(body),
    'settings.updatePayment': ({ body }) => saveSettings(body),
    'settings.setup': async ({ req }) => {
      const [saved, kit, stats, reels, comments, instagram] = await Promise.all([repos.settings.getAll(), repos.brandKit.get(), repos.stats.dashboard(), repos.reels.list(), repos.activity.count(), client()]);
      let username = '';
      try {
        username = instagram ? (await instagram.getAccount())?.username ?? '' : '';
      } catch {
        username = '';
      }
      return {
        storeUrl: baseUrlFor(req, config),
        testMode: Boolean(config.dryRun),
        instagram: { connected: Boolean(username), username },
        checklist: {
          dismissed: saved.checklist_dismissed === '1',
          steps: [
            { key: 'instagram', done: Boolean(username) },
            { key: 'store_details', done: saved.store_name !== SETTING_DEFAULTS.store_name || Boolean(kit.logoUrl) },
            { key: 'products', done: stats.products > 0 },
            { key: 'reel', done: reels.length > 0 },
            { key: 'comment', done: comments > 0 },
            { key: 'order', done: stats.orders > 0 },
          ],
        },
      };
    },

    'brandKit.get': () => repos.brandKit.get(),
    'brandKit.update': ({ body }) => repos.brandKit.save(body),
    'brandKit.presets': async ({ query }) => page((await repos.brandKit.presets()).map((p) => ({ code: p.code, name: p.name, colors: p.colors, headingFont: p.heading_font, bodyFont: p.body_font })), query),

    'activity.list': async ({ query }) => page((await repos.activity.list({ limit: 500 })).map((a) => ({
      id: a.id, commentId: a.comment_id, reelId: a.reel_id, reelHeadline: a.headline ?? null, reelSlug: a.slug ?? null, username: a.username, text: a.text, result: a.result, error: a.error ?? '', createdAt: a.created_at,
    })), query),

    'stats.dashboard': async () => {
      const s = await repos.stats.dashboard();
      return { dms: s.dms, dmsToday: s.dms_today, visits: s.visits, visitsToday: s.visits_today, orders: s.orders, ordersToday: s.orders_today, revenuePaise: s.revenue, toConfirm: s.to_confirm, toShip: s.to_ship, products: s.products };
    },

    'media.upload': async ({ file }) => {
      const id = await repos.media.save(file.buffer, file.mimetype);
      return { id, url: `/media/${id}` };
    },
  };
}

const standIn = {
  name: 'console-api-stand-in',
  api(ctx) {
    const answered = new Set(ctx.modules.filter((module) => module !== standIn).flatMap((module) => Object.keys(module.api?.(ctx) ?? {})));
    return Object.fromEntries(Object.entries(handlers(ctx)).filter(([id]) => !answered.has(id)));
  },
};

/** The app's modules plus the stand-in. Pass to startApp as `modules`. */
export const withConsoleApi = (extra = []) => [...MODULES, ...extra, standIn];
