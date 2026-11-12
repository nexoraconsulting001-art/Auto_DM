/**
 * The pre-submit gate's checks (PRD 10.14), as pure functions over facts. Nothing here reads a file, the database or the network:
 * tools/presubmit/inspect.mjs gathers the facts of a built app, and the server (src/modules/app-submissions/presubmit.js) adds
 * what only it knows (review access, its own routes, the brand's ids and hosts). Both run runChecks() below, so the console,
 * the CLI and the pipeline can never disagree about a verdict.
 *
 *   runChecks({ platform, app, server }) -> { passed, checks: [{ code, guideline, passed, detail }] }
 *
 * One entry per PRESUBMIT_CHECKS code for that platform, always, in the contract's order. `detail` is one plain sentence: what
 * was found, or what is missing and what to do. It never holds a key, a token or a person's details.
 *
 * App facts (inspect.mjs: inspectApp, releaseFacts):
 *   { appVersion, expoSdk, dependencies: [name], webviewImports: [file], features: [name], accountDeleteScreen, accountDeleteCall,
 *     pushAtLaunch: [file], android: { targetSdkVersion, permissions: [] }, ios: { privacyManifest, entitlements, toolchain: {
 *     xcode, sdk, source } } }
 * Server facts:
 *   { reviewAccess: { enabled, phone, code }, accountDeletionRoute, push: { toggles: [], defaultOn: [] }, brand: { texts: [] } }
 */
import { ANDROID_TARGET_SDK_MIN, IOS_SDK_MIN, IOS_XCODE_MIN, namesPlatform, presubmitChecksFor, presubmitPassed } from '../../src/contracts/apps.js';

/** The nine screens a reviewer walks through: each must be a native screen of the app's own feature registry (4.2). */
export const NATIVE_SCREENS = Object.freeze(['home', 'catalog', 'category', 'product', 'search', 'cart', 'checkout', 'orders', 'account']);
/** A library that renders web pages inside the app. The system browser tab (expo-web-browser) is not one. */
export const WEBVIEW_LIBRARY = /(^|[/@-])(react-native-webview|webview)($|[/-])/i;
/** In-app purchase and store billing libraries (3.1.3(e)): payment is the gateway's, never the store's. */
export const IAP_LIBRARY = /(^|[/@-])(iap|in-app-purchases?|purchases|billing|storekit|revenuecat|play-billing)($|[/-])/i;
export const IAP_ENTITLEMENT = 'com.apple.developer.in-app-payments';
export const BILLING_PERMISSION = 'com.android.vending.BILLING';
/** The required-reason APIs React Native and the Expo modules the app links use; the privacy manifest declares each (P-57). */
export const REQUIRED_REASON_APIS = Object.freeze([
  'NSPrivacyAccessedAPICategoryUserDefaults',
  'NSPrivacyAccessedAPICategoryFileTimestamp',
  'NSPrivacyAccessedAPICategorySystemBootTime',
  'NSPrivacyAccessedAPICategoryDiskSpace',
]);
const REASON_CODE = /^[A-Z0-9]{3,4}\.[0-9]$/;
const PUSH_TOGGLES = Object.freeze(['order_updates', 'offers', 'new_reels']);

const list = (items) => items.join(', ');
const versionParts = (text) => String(text ?? '').split('.').map((n) => Number.parseInt(n, 10)).map((n) => (Number.isFinite(n) ? n : 0));
/** a >= b for dotted versions ('26.1' >= '26.0'). */
export function versionAtLeast(a, b) {
  if (a === null || a === undefined || a === '') return false;
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
}

const ok = (detail) => ({ passed: true, detail });
const fail = (detail) => ({ passed: false, detail });
const asList = (value) => (Array.isArray(value) ? value.map(String) : []);

const CHECKS = {
  native_screens(app) {
    const features = new Set(asList(app.features));
    const absent = NATIVE_SCREENS.filter((name) => !features.has(name));
    const libraries = asList(app.dependencies).filter((name) => WEBVIEW_LIBRARY.test(name));
    const imports = asList(app.webviewImports);
    if (absent.length) return fail(`These screens are not native screens of the app: ${list(absent)}.`);
    if (libraries.length) return fail(`A web view library is in the build: ${list(libraries)}. Every screen must be native.`);
    if (imports.length) return fail(`These files show a web view: ${list(imports.slice(0, 5))}. Every screen must be native.`);
    return ok(`The ${NATIVE_SCREENS.length} screens are native and no web view library is in the build.`);
  },

  account_deletion(app, server) {
    if (!app.accountDeleteScreen) return fail('The account screen does not offer Delete my account.');
    if (!app.accountDeleteCall) return fail('The app cannot call the account deletion route.');
    if (!server.accountDeletionRoute) return fail('The server does not answer the account deletion route.');
    return ok('The account screen offers Delete my account and the server answers the deletion route.');
  },

  gateway_payments(app, _server, platform) {
    const libraries = asList(app.dependencies).filter((name) => IAP_LIBRARY.test(name));
    if (libraries.length) return fail(`An in-app purchase library is in the build: ${list(libraries)}. Payment must be the gateway’s.`);
    if (platform === 'ios' && app.ios?.entitlements && Object.hasOwn(app.ios.entitlements, IAP_ENTITLEMENT)) return fail('The build asks for the in-app payments entitlement. Payment must be the gateway’s.');
    if (platform === 'android' && asList(app.android?.permissions).includes(BILLING_PERMISSION)) return fail('The build asks for the store billing permission. Payment must be the gateway’s.');
    return ok('No in-app purchase library or entitlement: payment is the gateway’s.');
  },

  demo_access(_app, server) {
    const access = server.reviewAccess ?? {};
    if (!access.enabled) return fail('Review access is off. Turn it on with the review number and its code before sending the app for review.');
    if (!access.phone || !access.code) return fail('Review access has no review number or code.');
    return ok('Review access is on: the review number signs in with its code on this store.');
  },

  push_opt_in_out(app, server) {
    const toggles = asList(server.push?.toggles);
    const absent = PUSH_TOGGLES.filter((t) => !toggles.includes(t));
    if (absent.length) return fail(`The notification settings lack these switches: ${list(absent)}.`);
    const onByDefault = asList(server.push?.defaultOn).filter((t) => t === 'offers' || t === 'new_reels');
    if (onByDefault.length) return fail(`These notifications are on before the shopper turns them on: ${list(onByDefault)}.`);
    const atLaunch = asList(app.pushAtLaunch);
    if (atLaunch.length) return fail(`The app asks for notification permission as it starts (${list(atLaunch.slice(0, 3))}). Ask only when the shopper turns a switch on.`);
    return ok('Three switches; offers and new reels are off until the shopper turns them on; no permission request at launch.');
  },

  target_api(app) {
    const target = Number(app.android?.targetSdkVersion);
    if (!Number.isInteger(target)) return fail('The build does not say its targetSdkVersion.');
    if (target < ANDROID_TARGET_SDK_MIN) return fail(`targetSdkVersion is ${target}. Google Play needs ${ANDROID_TARGET_SDK_MIN} or higher.`);
    return ok(`targetSdkVersion is ${target}.`);
  },

  ios_sdk(app) {
    const toolchain = app.ios?.toolchain ?? {};
    if (!toolchain.xcode || !toolchain.sdk) return fail('The build does not say which Xcode and iOS SDK made it.');
    if (!versionAtLeast(toolchain.xcode, String(IOS_XCODE_MIN))) return fail(`Built with Xcode ${toolchain.xcode}. The App Store needs Xcode ${IOS_XCODE_MIN} or later.`);
    if (!versionAtLeast(toolchain.sdk, IOS_SDK_MIN)) return fail(`Built with the iOS ${toolchain.sdk} SDK. The App Store needs iOS ${IOS_SDK_MIN} or later.`);
    return ok(`Xcode ${toolchain.xcode} with the iOS ${toolchain.sdk} SDK${toolchain.source ? ` (${toolchain.source})` : ''}.`);
  },

  privacy_manifest(app) {
    const manifest = app.ios?.privacyManifest;
    if (!manifest || typeof manifest !== 'object') return fail('The build has no PrivacyInfo.xcprivacy.');
    if (manifest.NSPrivacyTracking !== false) return fail('The privacy manifest does not declare tracking off.');
    if (asList(manifest.NSPrivacyTrackingDomains).length) return fail('The privacy manifest lists tracking domains.');
    const declared = new Map((Array.isArray(manifest.NSPrivacyAccessedAPITypes) ? manifest.NSPrivacyAccessedAPITypes : []).map((entry) => [entry?.NSPrivacyAccessedAPIType, entry]));
    const undeclared = REQUIRED_REASON_APIS.filter((type) => !declared.has(type));
    if (undeclared.length) return fail(`These required-reason APIs are not declared: ${list(undeclared.map((t) => t.replace('NSPrivacyAccessedAPICategory', '')))}.`);
    const noReason = [...declared.entries()].filter(([, entry]) => !asList(entry?.NSPrivacyAccessedAPITypeReasons).length || !asList(entry.NSPrivacyAccessedAPITypeReasons).every((r) => REASON_CODE.test(r)));
    if (noReason.length) return fail(`These required-reason APIs have no valid reason code: ${list(noReason.map(([t]) => String(t).replace('NSPrivacyAccessedAPICategory', '')))}.`);
    return ok(`Tracking is off and all ${declared.size} required-reason APIs are declared with their reasons.`);
  },

  brand_only(app, server) {
    const texts = [...asList(server.brand?.texts), ...asList(app.brandTexts)];
    const naming = texts.filter((text) => namesPlatform(text));
    if (naming.length) return fail(`${naming.length} of the brand’s names, ids or hosts name the platform.`);
    if (!texts.length) return fail('The brand’s names, ids and hosts were not given to the check.');
    return ok('Only the business’s brand is in the app’s names, ids and hosts.');
  },
};

/** Every check of PRESUBMIT_CHECKS for `platform`, in order, each answered. */
export function runChecks({ platform, app = {}, server = {} }) {
  const wanted = presubmitChecksFor(platform);
  if (!wanted.length) throw new TypeError('runChecks needs android or ios');
  const checks = wanted.map((check) => {
    let result;
    try {
      result = CHECKS[check.code]?.(app ?? {}, server ?? {}, platform) ?? fail('This check is not known to this tool.');
    } catch {
      result = fail('This check could not read the build’s facts.');
    }
    return { code: check.code, guideline: check.guideline, passed: result.passed === true, detail: String(result.detail).slice(0, 500) };
  });
  return { passed: presubmitPassed(platform, checks), checks };
}

/** The failed checks as one line that names each guideline: 'account_deletion (5.1.1(v)): ...'. */
export function failureSummary(checks = []) {
  return checks.filter((c) => !c.passed).map((c) => `${c.code} (${c.guideline || 'brand'}): ${c.detail}`).join(' ');
}
