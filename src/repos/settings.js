import { tenantId } from '../tenancy.js';

export const SETTING_DEFAULTS = {
  store_name: 'My store',
  tagline: 'Everything from our reels, in one place.',
  instagram_handle: '',
  shipping_fee_paise: '4900',
  free_shipping_above_paise: '99900',
  upi_id: 'demo@upi',
  upi_payee: '',
  support_whatsapp: '',
  support_email: '',
  hero_kicker: '',
  hero_title: 'Shop the reels you love',
  hero_subtitle: 'Everything from our Instagram reels, in one place.',
  trust_points: 'Ships across India\nSecure UPI payment\nQuick help on WhatsApp',
  bulk_title: 'Buying in bulk?',
  bulk_text: 'Message us on WhatsApp for bulk-order offers.',
  about_text: '',
  gstin: '',
  checklist_dismissed: '',
};

export function settingsRepo(db) {
  return {
    async getAll() {
      const rows = await db.query('SELECT key, value FROM settings WHERE tenant_id = $1', [tenantId()]);
      const out = { ...SETTING_DEFAULTS };
      for (const { key, value } of rows) if (key in out) out[key] = value;
      return out;
    },
    /** Saves all of `values` or none of them, so a failure can't leave a new UPI id beside the old payee. */
    async update(values) {
      await db.tx(async (t) => {
        for (const [key, value] of Object.entries(values)) {
          if (!(key in SETTING_DEFAULTS)) continue;
          await t.query(
            'INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value',
            [tenantId(), key, String(value ?? '')],
          );
        }
      });
    },
  };
}

export const shippingFor = (subtotalPaise, settings) => {
  const fee = Number(settings.shipping_fee_paise) || 0;
  const freeAbove = Number(settings.free_shipping_above_paise) || 0;
  if (subtotalPaise === 0) return 0;
  return freeAbove > 0 && subtotalPaise >= freeAbove ? 0 : fee;
};
