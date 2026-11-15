import { z } from 'zod';

/**
 * The go-live checklist as data (Phase 10; G-15 to G-17). Every outside approval, account and setting that stands
 * between the built platform and a real customer, one item each: who must act, which release phase it blocks, whether
 * it blocks go-live, and how it is checked. `npm run golive` and the Platform Console's platform.goliveStatus both
 * answer from this list through src/modules/golive, so the two can never disagree.
 *
 * How an item is checked (`check.kind`):
 *   setting       the named settings are present and none is a test value: a simulator or test address, a test-mode
 *                 key, an example or placeholder (isTestValue below). `all` settings must pass; `any` needs one.
 *   probe         a live question through an adapter, named in GOLIVE_PROBES: the golive module supplies one function
 *                 per name, async (ctx) => { state: 'ready' | 'missing' | 'unknown', detail }. `unknown` (the provider
 *                 could not be asked) counts as missing for a blocking item.
 *   attestation   what no API can show: an entry in deploy/golive/attestations.json signed off by a named person on a
 *                 date (GoliveAttestations). No entry, or one older than `maxAgeDays`, is missing.
 *   per_business  done by each business for itself through onboarding (src/contracts/onboarding.js): listed so every
 *                 row of the dependencies table is here, shown as a count of businesses, and never blocks go-live.
 *
 * `owner` is who must act: `us` (the build team: code, configuration, a console we already have access to) or `user`
 * (the founder: an account to buy, a form to file, a legal view to obtain, a sign-off). `phase` is the release phase
 * that cannot reach customers without it (PRD 13): 0 foundation, 1 automation, 2 insights, 3 store, 4 owner app,
 * 5 shopper apps; add-ons carry the phase they ship with.
 *
 * Nothing printed or returned by the checklist holds a setting's value: an item's `detail` is a short fixed phrase
 * (GOLIVE_DETAILS) or the name of a setting.
 */
export const GOLIVE_OWNERS = Object.freeze(['us', 'user']);
export const GOLIVE_STATES = Object.freeze(['ready', 'missing', 'unknown']);
export const GOLIVE_CHECK_KINDS = Object.freeze(['setting', 'probe', 'attestation', 'per_business']);

/** The live probes, by name. The golive module answers each; an adapter never sends a message or changes anything. */
export const GOLIVE_PROBES = Object.freeze([
  'meta.app_mode', 'meta.business_verification', 'meta.tech_provider', 'meta.permission_access', 'meta.webhook_subscription', 'meta.privacy_and_deletion',
  'razorpay.route_live', 'razorpay.billing_live', 'shiprocket.account', 'whatsapp.sender', 'whatsapp.templates', 'google.signin_client',
  'push.fcm', 'push.apns', 'ai.provider', 'email.sender', 'dns.platform_hosts', 'tls.platform_hosts', 'backups.recent', 'monitoring.scraping', 'monitoring.uptime_probe',
  'secrets.rewrap_done', 'runtime.production_guard', 'eas.account', 'stores.owner_app_listed',
]);

/** The Meta permissions the code asks for (the App Review pack lists exactly these, G-18), each needing Advanced Access. */
export const META_PERMISSIONS = Object.freeze({
  instagram: Object.freeze(['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights']),
  facebook: Object.freeze(['pages_show_list', 'pages_manage_metadata', 'pages_messaging', 'pages_read_engagement', 'pages_manage_engagement']),
  whatsapp: Object.freeze(['whatsapp_business_management', 'whatsapp_business_messaging']),
});

const setting = (all, any = []) => Object.freeze({ kind: 'setting', all: Object.freeze(all), any: Object.freeze(any) });
const probe = (name, args = {}) => Object.freeze({ kind: 'probe', probe: name, args: Object.freeze(args) });
const attestation = (maxAgeDays = 365) => Object.freeze({ kind: 'attestation', maxAgeDays });
const perBusiness = (step) => Object.freeze({ kind: 'per_business', step });
const item = (id, title, owner, phase, blocks, check, dependency = '') => Object.freeze({ id, title, owner, phase, blocks, check, dependency });

export const GOLIVE_ITEMS = Object.freeze([
  // Meta: the longest wait, and it gates every real customer.
  item('meta.business_verification', 'Meta Business Verification for Bhava is complete', 'user', 0, true, probe('meta.business_verification'), 'Meta Business Verification'),
  item('meta.app_live', 'The Meta app is in Live mode, not Development', 'us', 0, true, probe('meta.app_mode'), 'Meta App Review'),
  item('meta.app_settings', 'The Meta app id, secret and webhook verify token are set and are not test values', 'us', 0, true, setting(['IG_APP_ID', 'APP_SECRET', 'VERIFY_TOKEN']), 'Meta App Review'),
  item('meta.instagram_access', 'Advanced Access is granted for every Instagram permission the code asks for', 'user', 1, true, probe('meta.permission_access', { group: 'instagram' }), 'Meta App Review'),
  item('meta.facebook_access', 'Advanced Access is granted for the Facebook Page permissions', 'user', 1, false, probe('meta.permission_access', { group: 'facebook' }), 'Meta App Review'),
  item('meta.tech_provider', 'Meta Tech Provider status is granted', 'user', 1, true, probe('meta.tech_provider'), 'Meta Tech Provider status'),
  item('meta.webhooks', 'The Meta app is subscribed to the webhook fields the code handles, at the platform address', 'us', 1, true, probe('meta.webhook_subscription'), 'Meta App Review'),
  item('meta.privacy_deletion', 'The privacy page and the data-deletion callback answer at their public addresses', 'us', 0, true, probe('meta.privacy_and_deletion'), 'Meta App Review'),
  item('meta.review_login', 'The App Review login and the demo business are set up', 'us', 0, true, setting(['REVIEW_LOGIN_PHONE', 'REVIEW_LOGIN_CODE_HASH']), 'Meta App Review'),
  // Payments and shipping on Bhava's own accounts.
  item('razorpay.route', 'Bhava’s Razorpay account has Route approved and live keys', 'user', 3, true, probe('razorpay.route_live'), 'Razorpay platform account with Route'),
  item('razorpay.settings', 'The Razorpay key, secret, webhook secret and partner client are set and are live-mode', 'us', 3, true, setting(['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_PARTNER_CLIENT_ID', 'RAZORPAY_PARTNER_CLIENT_SECRET']), 'Razorpay platform account with Route'),
  item('razorpay.billing', 'Razorpay Subscriptions for Bhava’s own billing is live, with its webhook secret', 'us', 1, true, probe('razorpay.billing_live'), 'Razorpay platform account with Route'),
  item('legal.payment_aggregator', 'Counsel’s view on payment aggregator rules for split settlement is on file', 'user', 3, true, attestation(), 'Razorpay platform account with Route'),
  item('shiprocket.account', 'Bhava’s Shiprocket master account answers, with its webhook token set', 'user', 3, true, probe('shiprocket.account'), 'Shiprocket master account'),
  // WhatsApp, Google, push, AI, email.
  item('whatsapp.sender', 'Bhava’s WhatsApp sender number is verified and can send', 'user', 0, true, probe('whatsapp.sender'), 'WhatsApp Business API account'),
  item('whatsapp.templates', 'Every WhatsApp template the code sends (login codes, alerts) is approved', 'us', 0, true, probe('whatsapp.templates'), 'WhatsApp Business API account'),
  item('whatsapp.addon_app', 'The WhatsApp embedded signup app id and configuration are set', 'us', 1, false, setting(['WHATSAPP_APP_ID', 'WHATSAPP_SIGNUP_CONFIG_ID', 'WHATSAPP_APP_SECRET']), 'WhatsApp Business Platform for the add-on'),
  item('google.signin', 'The Google sign-in clients are set and their consent screen is verified', 'user', 0, true, probe('google.signin_client'), 'Google sign-in'),
  item('push.fcm', 'FCM accepts the server’s credentials for the owner app', 'us', 4, true, probe('push.fcm'), 'Bhava for Business store listings'),
  item('push.apns', 'APNs accepts the production key for the owner app', 'us', 4, true, probe('push.apns'), 'Bhava for Business store listings'),
  item('ai.provider', 'The AI provider account answers and its contract forbids training on our traffic', 'user', 1, false, probe('ai.provider'), 'AI provider account'),
  item('email.sender', 'The email provider is chosen and its sending domain passes DKIM', 'us', 3, false, probe('email.sender'), ''),
  // Stores and builds.
  item('stores.accounts', 'Bhava’s Apple Developer and Google Play organisation accounts are bought and verified', 'user', 4, true, attestation(), 'Bhava for Business store listings'),
  item('stores.owner_app', 'Bhava for Business is approved on both stores', 'user', 4, true, probe('stores.owner_app_listed'), 'Bhava for Business store listings'),
  item('builds.eas', 'The cloud build account is set and answers', 'us', 5, false, probe('eas.account'), 'Cloud app builds'),
  // The platform itself.
  item('hosting.guard', 'The running configuration passes every production rule, with DEPLOY_ENV=production', 'us', 0, true, probe('runtime.production_guard'), ''),
  item('hosting.dns', 'The platform hosts resolve to the load balancer', 'user', 0, true, probe('dns.platform_hosts'), ''),
  item('hosting.tls', 'Every platform host serves a valid certificate with more than 14 days left', 'us', 0, true, probe('tls.platform_hosts'), ''),
  item('hosting.backups', 'A backup finished in the last 26 hours and a restore drill has passed', 'us', 0, true, probe('backups.recent'), ''),
  item('hosting.monitoring', 'Metrics are scraped and alerts reach a person', 'us', 0, true, probe('monitoring.scraping'), ''),
  item('hosting.uptime_probe', 'The outside probe of webhooks and shopper pages is running', 'us', 0, true, probe('monitoring.uptime_probe'), ''),
  item('hosting.secrets', 'Stored secrets are all under the current master key in the envelope form', 'us', 0, true, probe('secrets.rewrap_done'), ''),
  item('hosting.region', 'Counsel has confirmed the hosting region and data location', 'user', 0, false, attestation(), ''),
  // Legal and brand.
  item('legal.pages', 'The terms, privacy policy and refund pages are reviewed by counsel', 'user', 0, true, attestation(), ''),
  item('legal.trademark', 'The trademark search for the platform name is done and filed', 'user', 0, false, attestation(730), ''),
  item('legal.dpdp', 'The data-protection notice, consent wording and grievance contact are reviewed', 'user', 0, true, attestation(), ''),
  item('showcase.signoff', 'The sample businesses have signed off the showcase', 'user', 1, true, attestation(180), ''),
  // Done by each business for itself: listed, counted, never blocking.
  item('business.instagram', 'Each business connects its Instagram professional account', 'user', 1, false, perBusiness('instagram'), 'Business connects its Instagram professional account'),
  item('business.domain', 'A business that wants its own domain points it at Bhava', 'user', 1, false, perBusiness('domain'), 'Custom domain pointed at Bhava'),
  item('business.linked_account', 'Each store finishes KYC for its linked account on Bhava’s Route', 'user', 3, false, perBusiness('payments'), 'Seller linked account on Route'),
  item('business.own_gateway', 'A business that brings its own gateway enters its keys', 'user', 3, false, perBusiness('payments'), 'Business’s own gateway account'),
  item('business.own_courier', 'A business that brings its own courier account enters its login', 'user', 3, false, perBusiness('shipping'), 'Business’s own Shiprocket account'),
  item('business.whatsapp_alerts', 'A store’s WhatsApp alert templates are approved', 'user', 3, false, perBusiness('whatsapp'), 'WhatsApp Business templates for alerts'),
  item('business.whatsapp_addon', 'A business with the WhatsApp add-on connects its own number', 'user', 1, false, perBusiness('whatsapp'), 'WhatsApp Business Platform for the add-on'),
  item('business.tags', 'A business that wants a pixel or analytics tag enters its ids', 'user', 2, false, perBusiness('tags'), 'Pixel, Conversions API and analytics tags'),
  item('business.play_account', 'A business with its own Android app has a Play organisation account', 'user', 5, false, perBusiness('store_access'), 'Google Play developer account'),
  item('business.duns', 'A business with its own app has a D-U-N-S number', 'user', 5, false, perBusiness('store_access'), 'D-U-N-S number'),
  item('business.apple_account', 'A business with its own iOS app is in the Apple Developer Program', 'user', 5, false, perBusiness('store_access'), 'Apple Developer Program'),
]);

/** The rows of the dependencies table (PRD 12), by a short label. The contract test checks each has an item. */
export const GOLIVE_DEPENDENCIES = Object.freeze([
  'Meta Business Verification', 'Meta App Review', 'Meta Tech Provider status', 'Business connects its Instagram professional account', 'Custom domain pointed at Bhava',
  'Razorpay platform account with Route', 'Seller linked account on Route', 'Shiprocket master account', 'Business’s own gateway account', 'Business’s own Shiprocket account',
  'WhatsApp Business API account', 'Google sign-in', 'WhatsApp Business templates for alerts', 'WhatsApp Business Platform for the add-on', 'AI provider account',
  'Pixel, Conversions API and analytics tags', 'Google Play developer account', 'D-U-N-S number', 'Apple Developer Program', 'Bhava for Business store listings', 'Cloud app builds',
]);

/** The fixed phrases an item's detail may be; anything else is the name of a setting. */
export const GOLIVE_DETAILS = Object.freeze({
  ok: 'Ready.',
  notSet: 'Not set.',
  testValue: 'Set to a test value.',
  simulator: 'Points at a simulator or test address.',
  developmentMode: 'The Meta app is in Development mode.',
  standardAccess: 'Standard Access only.',
  notSignedOff: 'Not signed off.',
  signOffExpired: 'The sign-off is too old.',
  unreachable: 'Could not be checked: the service did not answer.',
  notBuilt: 'This check is not built yet.',
  perBusiness: 'Done by each business.',
  qaProfile: 'DEPLOY_ENV is not production.',
});

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i;

/**
 * True when a setting's value cannot be a production one (G-16): a simulator or test address, a provider's test-mode
 * key, or a placeholder. Reads the value and answers a boolean; the value goes nowhere.
 */
export function isTestValue(value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (/^(rzp_test_|sk_test_|pk_test_)/i.test(v)) return true;
  if (/^(changeme|change-me|todo|tbd|xxx+|placeholder|example|dummy|test|secret|password|sim[-_].*|.*[-_]sim)$/i.test(v)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const { protocol, hostname } = new URL(v);
      return protocol === 'http:' || LOOPBACK.test(hostname) || /(^|\.)(test|localhost|example|invalid|local)$/i.test(hostname) || /(^|\.)example\.(com|org|net)$/i.test(hostname);
    } catch {
      return true;
    }
  }
  return false;
}

/** One entry of deploy/golive/attestations.json: who signed what off, and when. No secret and no document goes in it. */
export const GoliveAttestation = z.strictObject({
  id: z.string().refine((id) => GOLIVE_ITEMS.some((i) => i.id === id && i.check.kind === 'attestation'), 'Not an item that is signed off'),
  signedOffBy: z.string().trim().min(2).max(80),
  role: z.string().trim().min(2).max(80),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Where the evidence is kept (a folder or a ticket), never the evidence itself.
  reference: z.string().trim().max(200).default(''),
});
export const GoliveAttestations = z.strictObject({ version: z.literal(1), entries: z.array(GoliveAttestation) });
export const GOLIVE_ATTESTATIONS_FILE = 'deploy/golive/attestations.json';

export const GoliveItemStatus = z.object({
  id: z.string(),
  title: z.string(),
  owner: z.enum(GOLIVE_OWNERS),
  phase: z.number().int().min(0).max(5),
  blocks: z.boolean(),
  kind: z.enum(GOLIVE_CHECK_KINDS),
  state: z.enum(GOLIVE_STATES),
  detail: z.string().max(200),
});

/** What platform.goliveStatus and `npm run golive -- --json` answer. `ready` is true only when no blocking item is missing or unknown. */
export const GoliveStatus = z.object({
  ready: z.boolean(),
  blockingMissing: z.number().int().min(0),
  checkedAt: z.coerce.date(),
  deployEnv: z.string().max(20),
  items: z.array(GoliveItemStatus),
});

/** A blocking item is open when it is anything but ready: a provider that could not be asked does not open the door. */
export const blockingOpen = (items) => items.filter((i) => i.blocks && i.state !== 'ready');

/** The checklist's exit code: 0 when go-live is clear, 1 while a blocking item is open. */
export const goliveExitCode = (status) => (blockingOpen(status.items).length ? 1 : 0);

/**
 * The guard sign-up asks before it opens to the public (G-17): `ok` false with the ids of what is missing.
 * The golive module registers a function of this shape with ctx.signupGuard.use().
 */
export const SignupGuardVerdict = z.object({ ok: z.boolean(), missing: z.array(z.string()).default([]) });
