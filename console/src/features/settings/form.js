import { paiseToRupees, rupeesToPaise } from '../../lib/format.js';

export const RENAME = { shippingFeePaise: 'shippingFee', freeShippingAbovePaise: 'freeShippingAbove' };

const TEXT_FIELDS = ['storeName', 'tagline', 'instagramHandle', 'supportWhatsapp', 'supportEmail', 'heroKicker', 'heroTitle', 'heroSubtitle', 'trustPoints', 'bulkTitle', 'bulkText', 'aboutText', 'gstin'];

export function settingsToForm(settings) {
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((name) => [name, settings[name]])),
    shippingFee: paiseToRupees(settings.shippingFeePaise),
    freeShippingAbove: paiseToRupees(settings.freeShippingAbovePaise),
  };
}

function moneyField(text, label, errors, name) {
  const paise = rupeesToPaise(text);
  if (Number.isNaN(paise)) errors[name] = `${label} must be a number like 49 or 49.50`;
  return paise ?? 0;
}

/** The form as the API wants it, or `errors` by field. An empty amount is zero, which is what the seller means by it. */
export function formToSettings(form) {
  const errors = {};
  const storeName = form.storeName.trim();
  if (!storeName) errors.storeName = 'Store name is required';
  const shippingFeePaise = moneyField(form.shippingFee, 'Delivery fee', errors, 'shippingFee');
  const freeShippingAbovePaise = moneyField(form.freeShippingAbove, 'Free delivery amount', errors, 'freeShippingAbove');
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      ...Object.fromEntries(TEXT_FIELDS.map((name) => [name, form[name].trim()])),
      storeName,
      instagramHandle: form.instagramHandle.trim().replace(/^@/, ''),
      supportWhatsapp: form.supportWhatsapp.replace(/\D/g, ''),
      shippingFeePaise,
      freeShippingAbovePaise,
    },
  };
}
