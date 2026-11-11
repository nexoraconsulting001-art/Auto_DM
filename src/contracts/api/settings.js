import { z } from 'zod';
import { MANAGERS, OWNER_ONLY } from './access.js';
import { Paise, PaiseInput, required, text } from './common.js';

const LONG = 4000;

export const Settings = z.object({
  storeName: z.string(),
  tagline: z.string(),
  instagramHandle: z.string(),
  shippingFeePaise: Paise,
  freeShippingAbovePaise: Paise,
  upiId: z.string(),
  upiPayee: z.string(),
  supportWhatsapp: z.string(),
  supportEmail: z.string(),
  heroKicker: z.string(),
  heroTitle: z.string(),
  heroSubtitle: z.string(),
  trustPoints: z.string(),
  bulkTitle: z.string(),
  bulkText: z.string(),
  aboutText: z.string(),
  gstin: z.string(),
  checklistDismissed: z.boolean(),
});

/** Every field is optional: what's left out stays as it is. */
export const SettingsUpdate = z.object({
  storeName: required(120, 'Store name is required'),
  tagline: text(400),
  instagramHandle: text(60),
  shippingFeePaise: PaiseInput,
  freeShippingAbovePaise: PaiseInput,
  supportWhatsapp: text(20),
  supportEmail: z.union([z.literal(''), z.email('Enter a valid email, or leave it empty').max(120)]),
  heroKicker: text(LONG),
  heroTitle: text(LONG),
  heroSubtitle: text(LONG),
  trustPoints: text(LONG),
  bulkTitle: text(LONG),
  bulkText: text(LONG),
  aboutText: text(LONG),
  gstin: text(20),
  checklistDismissed: z.boolean(),
}).partial();

/** Where shoppers' money goes, so it is the owner's alone. The two Razorpay fields go together, and the secret never comes back. */
export const PaymentSettingsUpdate = z.object({
  upiId: text(120),
  upiPayee: text(120),
  razorpayKeyId: z.string().trim().regex(/^rzp_(?:test|live)_[A-Za-z0-9]{6,40}$/, 'Use the key id from your Razorpay dashboard'),
  razorpayKeySecret: required(200, 'Enter the key secret'),
}).partial();

export const SetupStatus = z.object({
  storeUrl: z.string(),
  testMode: z.boolean(),
  instagram: z.object({ connected: z.boolean(), username: z.string() }),
  checklist: z.object({
    dismissed: z.boolean(),
    steps: z.array(z.object({ key: z.enum(['instagram', 'store_details', 'products', 'reel', 'comment', 'order']), done: z.boolean() })),
  }),
});

export const settingRoutes = {
  'settings.get': { method: 'GET', path: '/settings', access: MANAGERS, response: Settings },
  'settings.update': { method: 'PATCH', path: '/settings', access: MANAGERS, body: SettingsUpdate, response: Settings },
  'settings.updatePayment': { method: 'PATCH', path: '/settings/payment', access: OWNER_ONLY, fresh: true, body: PaymentSettingsUpdate, response: Settings },
  'settings.setup': { method: 'GET', path: '/settings/setup', access: MANAGERS, response: SetupStatus },
};
