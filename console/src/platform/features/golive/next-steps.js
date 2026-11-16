/**
 * What to do next for each go-live item that is not ready (G-15), and the labels the report and the Platform Console use.
 * Plain data with no imports, so the console's page reads the same words as `npm run golive`. Nothing here holds a value
 * of any setting: a step names the setting, the file or the console where the work is done.
 */
export const OWNER_LABELS = Object.freeze({ us: 'Bhava team', user: 'Founder' });

export const PHASE_LABELS = Object.freeze({
  0: 'Phase 0: foundation',
  1: 'Phase 1: automation',
  2: 'Phase 2: insights',
  3: 'Phase 3: store',
  4: 'Phase 4: owner app',
  5: 'Phase 5: shopper apps',
});

/** `unknown` is shown as "not checked": nobody could ask, so it is never counted as ready. */
export const STATE_LABELS = Object.freeze({ ready: 'Ready', missing: 'Missing', unknown: 'Not checked' });

const SIGN_OFF = 'Add an entry for this item to deploy/golive/attestations.json with the name, role and date of the person who signed it off, and where the evidence is kept (never the evidence itself).';

export const NEXT_STEPS = Object.freeze({
  'meta.business_verification': 'In Meta Business Settings, open Security Centre and finish Business Verification for Bhava’s business.',
  'meta.app_live': 'In the Meta app dashboard, switch the app from Development to Live (it needs the privacy page and the data-deletion callback first).',
  'meta.app_settings': 'Put the Meta app’s real id, secret and webhook verify token into the secret source as IG_APP_ID, APP_SECRET and VERIFY_TOKEN.',
  'meta.instagram_access': 'Submit App Review for every Instagram permission the code asks for and wait for Advanced Access on each.',
  'meta.facebook_access': 'Submit App Review for the Facebook Page permissions and wait for Advanced Access on each.',
  'meta.tech_provider': 'Apply for Meta Tech Provider status from the app dashboard once Business Verification is done.',
  'meta.webhooks': 'In the Meta app’s Webhooks settings, subscribe the Instagram object to comments, mentions, messages and messaging_postbacks at the platform’s /webhook address.',
  'meta.privacy_deletion': 'Deploy the platform so /privacy and /meta/deletion answer on the public https address, and enter both in the Meta app’s basic settings.',
  'meta.review_login': 'Set REVIEW_LOGIN_PHONE and REVIEW_LOGIN_CODE_HASH for the App Review login and load the demo business.',
  'razorpay.route': 'Ask Razorpay to approve Route on Bhava’s account, then put the live key id and secret into the secret source.',
  'razorpay.settings': 'Put the live-mode Razorpay key id, secret, webhook secret and partner client id and secret into the secret source.',
  'razorpay.billing': 'Turn on Razorpay Subscriptions on the live account and set its webhook secret as RAZORPAY_BILLING_WEBHOOK_SECRET.',
  'legal.payment_aggregator': `Get counsel’s written view on payment aggregator rules for split settlement. ${SIGN_OFF}`,
  'shiprocket.account': 'Open Bhava’s Shiprocket master account, make its API user, and set SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD and SHIPROCKET_WEBHOOK_TOKEN.',
  'whatsapp.sender': 'Verify Bhava’s WhatsApp sender number in WhatsApp Manager and set PLATFORM_WHATSAPP_PHONE_ID and PLATFORM_WHATSAPP_TOKEN.',
  'whatsapp.templates': 'Submit every WhatsApp template the code sends (the login code and each alert) in Bhava’s account and wait for approval; set PLATFORM_WHATSAPP_WABA_ID so they can be checked.',
  'whatsapp.addon_app': 'Make the WhatsApp embedded signup configuration and set WHATSAPP_APP_ID, WHATSAPP_SIGNUP_CONFIG_ID and WHATSAPP_APP_SECRET.',
  'google.signin': 'Make the Google sign-in clients, set their ids and secrets, and send the OAuth consent screen for verification.',
  'push.fcm': 'Make a Firebase service account for the owner app and set FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT.',
  'push.apns': 'Make an APNs key in the Apple Developer account and set APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY, APNS_TOPIC and APNS_ENV=production.',
  'ai.provider': 'Open the AI provider account under a contract that forbids training on our traffic, and set AI_BASE_URL and AI_API_KEY.',
  'email.sender': 'Choose the email provider, publish its DKIM record for the sending domain, and set EMAIL_BASE_URL, EMAIL_API_KEY, PLATFORM_EMAIL_FROM and EMAIL_DKIM_SELECTOR.',
  'stores.accounts': `Buy Bhava’s Apple Developer and Google Play organisation accounts and finish their verification. ${SIGN_OFF}`,
  'stores.owner_app': 'Submit Bhava for Business to both stores and wait for approval; set OWNER_APP_BUNDLE_ID and OWNER_APP_PACKAGE so it can be checked.',
  'builds.eas': 'Make the cloud build account and set EXPO_TOKEN and EAS_ACCOUNT.',
  'hosting.guard': 'Run with DEPLOY_ENV=production and fix every rule `npm run prod:validate` names.',
  'hosting.dns': 'Point every platform host at the load balancer in DNS (set LOAD_BALANCER_ADDRESS to have it compared).',
  'hosting.tls': 'Issue certificates for every platform host and keep them renewing; more than 14 days must be left.',
  'hosting.backups': 'Turn on the nightly backup in the worker and run `npm run drill` until the restore drill passes.',
  'hosting.monitoring': 'Point Prometheus at /metrics with METRICS_TOKEN, route alerts to a person in Alertmanager, and set PROMETHEUS_URL and ALERTMANAGER_URL.',
  'hosting.uptime_probe': 'Run the outside probe (blackbox) against the webhook and a shopper page, scraped by the Prometheus at PROMETHEUS_URL.',
  'hosting.secrets': 'Set SECRETS_FORMAT=v2 and let the re-wrap job finish under the current DATA_KEY.',
  'hosting.region': `Ask counsel to confirm the hosting region and where the data lives. ${SIGN_OFF}`,
  'legal.pages': `Have counsel review the terms, privacy policy and refund pages. ${SIGN_OFF}`,
  'legal.trademark': `Run the trademark search for the platform name and file the application. ${SIGN_OFF}`,
  'legal.dpdp': `Have the data-protection notice, the consent wording and the grievance contact reviewed. ${SIGN_OFF}`,
  'showcase.signoff': `Ask the sample businesses to sign off the showcase. ${SIGN_OFF}`,
});

export const PER_BUSINESS_STEP = 'Nothing to do before go-live: each business does this for itself in onboarding.';

/** The next step for one item of the status, or '' when it is ready. */
export function nextStepFor(item) {
  if (item.kind === 'per_business') return PER_BUSINESS_STEP;
  if (item.state === 'ready') return '';
  const step = NEXT_STEPS[item.id] ?? 'Look at this item in src/contracts/golive.js.';
  return item.state === 'unknown' ? `Run the live checks again (npm run golive without --offline). If it stays not checked: ${step}` : step;
}
