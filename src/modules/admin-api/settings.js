import { SETTING_DEFAULTS } from '../../repos/settings.js';
import { mapPage, pageOf } from './paging.js';
import { storeBaseUrl } from './urls.js';

const toSettings = (s) => ({
  storeName: s.store_name,
  tagline: s.tagline,
  instagramHandle: s.instagram_handle,
  shippingFeePaise: Number(s.shipping_fee_paise) || 0,
  freeShippingAbovePaise: Number(s.free_shipping_above_paise) || 0,
  upiId: s.upi_id,
  upiPayee: s.upi_payee,
  supportWhatsapp: s.support_whatsapp,
  supportEmail: s.support_email,
  heroKicker: s.hero_kicker,
  heroTitle: s.hero_title,
  heroSubtitle: s.hero_subtitle,
  trustPoints: s.trust_points,
  bulkTitle: s.bulk_title,
  bulkText: s.bulk_text,
  aboutText: s.about_text,
  gstin: s.gstin,
  checklistDismissed: s.checklist_dismissed === '1',
});

// API field -> settings key, with how the value is stored when it isn't stored as given.
const SETTING_FIELDS = {
  storeName: ['store_name'],
  tagline: ['tagline'],
  instagramHandle: ['instagram_handle', (handle) => handle.replace(/^@/, '')],
  shippingFeePaise: ['shipping_fee_paise'],
  freeShippingAbovePaise: ['free_shipping_above_paise'],
  supportWhatsapp: ['support_whatsapp', (number) => number.replace(/[^\d]/g, '')],
  supportEmail: ['support_email'],
  heroKicker: ['hero_kicker'],
  heroTitle: ['hero_title'],
  heroSubtitle: ['hero_subtitle'],
  trustPoints: ['trust_points'],
  bulkTitle: ['bulk_title'],
  bulkText: ['bulk_text'],
  aboutText: ['about_text'],
  gstin: ['gstin'],
  checklistDismissed: ['checklist_dismissed', (dismissed) => (dismissed ? '1' : '')],
  upiId: ['upi_id', (id) => id || SETTING_DEFAULTS.upi_id],
  upiPayee: ['upi_payee'],
};

function settingValues(body) {
  return Object.fromEntries(Object.entries(body).map(([field, value]) => {
    const [key, stored = (given) => given] = SETTING_FIELDS[field];
    return [key, stored(value)];
  }));
}

const toStats = (s) => ({
  dms: s.dms,
  dmsToday: s.dms_today,
  visits: s.visits,
  visitsToday: s.visits_today,
  orders: s.orders,
  ordersToday: s.orders_today,
  revenuePaise: s.revenue,
  toConfirm: s.to_confirm,
  toShip: s.to_ship,
  products: s.products,
});

const toThemePreset = (p) => ({ code: p.code, name: p.name, colors: p.colors, headingFont: p.heading_font, bodyFont: p.body_font });

export function settingsApi({ repos, config }, setup) {
  async function saveSettings(body) {
    await repos.settings.update(settingValues(body));
    return toSettings(await repos.settings.getAll());
  }

  return {
    'settings.get': async () => toSettings(await repos.settings.getAll()),
    'settings.update': ({ body }) => saveSettings(body),
    'settings.updatePayment': ({ body }) => saveSettings(body),

    'settings.setup': async ({ req }) => {
      const [settings, kit, stats, reels, client] = await Promise.all([
        repos.settings.getAll(), repos.brandKit.get(), repos.stats.dashboard(), repos.reels.list(), setup.igClient(),
      ]);
      // One after the other, so the checklist's Instagram check fills the cache and this answer reuses it.
      const checklist = await setup.setupChecklist(settings, kit, stats, reels, client);
      const instagram = await setup.instagramStatus(client);
      return { storeUrl: storeBaseUrl(req, config), testMode: config.dryRun, instagram, checklist };
    },

    'brandKit.get': () => repos.brandKit.get(),
    'brandKit.update': ({ body }) => repos.brandKit.save(body),
    'brandKit.presets': async ({ query }) => mapPage(pageOf(await repos.brandKit.presets(), query), toThemePreset),

    'stats.dashboard': async () => toStats(await repos.stats.dashboard()),
  };
}
