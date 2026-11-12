/**
 * The store privacy answers, worked out from collection.json (what the app collects, and where) and
 * privacy-manifest.json (the required-reason APIs). One source, three outputs, so they cannot drift apart:
 *
 *   privacyManifest()   the iOS privacy manifest; app.config.js builds ios.privacyManifests with it
 *   appPrivacy()        the App Store Connect "App Privacy" answers (app-store/app-privacy.json)
 *   dataSafety()        the Google Play "Data safety" answers (play/data-safety.json)
 *
 * CommonJS, because app.config.js is CommonJS and Expo loads it with no build step.
 */
const collection = require('./collection.json');
const manifest = require('./privacy-manifest.json');

/** What a purpose in collection.json is called in each store. Apple puts sign-in and security under App Functionality. */
const PURPOSES = Object.freeze({
  appFunctionality: { play: 'App functionality', apple: 'NSPrivacyCollectedDataTypePurposeAppFunctionality', appleLabel: 'App Functionality' },
  accountManagement: { play: 'Account management', apple: 'NSPrivacyCollectedDataTypePurposeAppFunctionality', appleLabel: 'App Functionality' },
  security: { play: 'Fraud prevention, security, and compliance', apple: 'NSPrivacyCollectedDataTypePurposeAppFunctionality', appleLabel: 'App Functionality' },
});

/** Apple's data types, with the App Store Connect category and label of each. */
const APPLE_TYPES = Object.freeze({
  NSPrivacyCollectedDataTypeName: ['Contact Info', 'Name'],
  NSPrivacyCollectedDataTypeEmailAddress: ['Contact Info', 'Email Address'],
  NSPrivacyCollectedDataTypePhoneNumber: ['Contact Info', 'Phone Number'],
  NSPrivacyCollectedDataTypePhysicalAddress: ['Contact Info', 'Physical Address'],
  NSPrivacyCollectedDataTypeOtherUserContactInfo: ['Contact Info', 'Other User Contact Info'],
  NSPrivacyCollectedDataTypeEmailsOrTextMessages: ['User Content', 'Emails or Text Messages'],
  NSPrivacyCollectedDataTypePhotosorVideos: ['User Content', 'Photos or Videos'],
  NSPrivacyCollectedDataTypeOtherUserContent: ['User Content', 'Other User Content'],
  NSPrivacyCollectedDataTypeCustomerSupport: ['User Content', 'Customer Support'],
  NSPrivacyCollectedDataTypeUserID: ['Identifiers', 'User ID'],
  NSPrivacyCollectedDataTypeDeviceID: ['Identifiers', 'Device ID'],
  NSPrivacyCollectedDataTypeProductInteraction: ['Usage Data', 'Product Interaction'],
  NSPrivacyCollectedDataTypeOtherFinancialInfo: ['Financial Info', 'Other Financial Info'],
  NSPrivacyCollectedDataTypePaymentInfo: ['Financial Info', 'Payment Info'],
  NSPrivacyCollectedDataTypeCrashData: ['Diagnostics', 'Crash Data'],
  NSPrivacyCollectedDataTypePerformanceData: ['Diagnostics', 'Performance Data'],
  NSPrivacyCollectedDataTypeOtherDiagnosticData: ['Diagnostics', 'Other Diagnostic Data'],
});

/** Google Play's data types, by category. */
const PLAY_TYPES = Object.freeze({
  'Personal info': ['Name', 'Email address', 'User IDs', 'Address', 'Phone number', 'Other info'],
  'Financial info': ['User payment info', 'Purchase history', 'Other financial info'],
  Messages: ['Emails', 'SMS or MMS', 'Other in-app messages'],
  'Photos and videos': ['Photos', 'Videos'],
  'Files and docs': ['Files and docs'],
  'App activity': ['App interactions', 'Other user-generated content', 'Other actions'],
  'App info and performance': ['Crash logs', 'Diagnostics', 'Other app performance data'],
  'Device or other IDs': ['Device or other IDs'],
});

const unique = (list) => [...new Set(list)];
const byKey = (rows, key) => {
  const out = new Map();
  for (const row of rows) out.set(row[key], [...(out.get(row[key]) ?? []), row]);
  return out;
};

/** Every problem with collection.json's own shape: an unknown type or purpose, a missing reason. */
function shapeProblems(data = collection) {
  const problems = [];
  const ids = new Set();
  for (const item of data.items) {
    if (ids.has(item.id)) problems.push(`collection.json lists "${item.id}" twice`);
    ids.add(item.id);
    if (!item.why) problems.push(`collection.json: "${item.id}" does not say why it is collected`);
    if (!APPLE_TYPES[item.apple]) problems.push(`collection.json: "${item.id}" has the Apple type "${item.apple}", which Apple does not have`);
    if (!PLAY_TYPES[item.play?.category]?.includes(item.play?.type)) problems.push(`collection.json: "${item.id}" has the Play type "${item.play?.category} / ${item.play?.type}", which Play does not have`);
    if (!item.purposes?.length) problems.push(`collection.json: "${item.id}" has no purpose`);
    for (const purpose of item.purposes ?? []) if (!PURPOSES[purpose]) problems.push(`collection.json: "${item.id}" has the purpose "${purpose}", which is not one of ${Object.keys(PURPOSES).join(', ')}`);
    if (item.tracking !== false) problems.push(`collection.json: "${item.id}" must say tracking: false; the app tracks no one`);
  }
  return problems;
}

/** The iOS privacy manifest (ios.privacyManifests in app.config.js). */
function privacyManifest(data = collection, reasons = manifest) {
  const types = [...byKey(data.items, 'apple')].map(([type, items]) => ({
    NSPrivacyCollectedDataType: type,
    NSPrivacyCollectedDataTypeLinked: items.some((item) => item.linked !== false),
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: unique(items.flatMap((item) => item.purposes.map((p) => PURPOSES[p]?.apple)).filter(Boolean)),
  }));
  return {
    NSPrivacyTracking: reasons.tracking === true,
    NSPrivacyTrackingDomains: [...reasons.trackingDomains],
    NSPrivacyCollectedDataTypes: types,
    NSPrivacyAccessedAPITypes: reasons.accessedApis.map((api) => ({ NSPrivacyAccessedAPIType: api.type, NSPrivacyAccessedAPITypeReasons: [...api.reasons] })),
  };
}

/** App Store Connect > App Privacy, in the order its questions come. */
function appPrivacy(data = collection) {
  return {
    note: 'Generated by apps/owner/store/check.mjs --write from collection.json. Enter these in App Store Connect > App Privacy; do not edit this file.',
    collectsData: data.items.length > 0,
    tracking: false,
    dataTypes: [...byKey(data.items, 'apple')].map(([type, items]) => ({
      category: APPLE_TYPES[type][0],
      type: APPLE_TYPES[type][1],
      linkedToUser: items.some((item) => item.linked !== false),
      usedForTracking: false,
      purposes: unique(items.flatMap((item) => item.purposes.map((p) => PURPOSES[p].appleLabel))),
      from: unique(items.map((item) => item.what)),
    })),
  };
}

/** Google Play Console > App content > Data safety. */
function dataSafety(data = collection) {
  const rows = data.items.map((item) => ({ ...item, key: `${item.play.category} / ${item.play.type}` }));
  return {
    note: 'Generated by apps/owner/store/check.mjs --write from collection.json. Enter these in Play Console > App content > Data safety; do not edit this file.',
    collectsOrShares: data.items.length > 0,
    encryptedInTransit: data.encryptedInTransit === true,
    deletionRequest: data.deletionRequest,
    dataTypes: [...byKey(rows, 'key')].map(([, items]) => ({
      category: items[0].play.category,
      type: items[0].play.type,
      collected: true,
      shared: items.some((item) => item.shared === true),
      ephemeral: items.every((item) => item.ephemeral === true),
      required: items.some((item) => item.required === true),
      purposes: unique(items.flatMap((item) => item.purposes.map((p) => PURPOSES[p].play))),
      from: unique(items.map((item) => item.what)),
    })),
  };
}

module.exports = { APPLE_TYPES, PLAY_TYPES, PURPOSES, appPrivacy, collection, dataSafety, manifest, privacyManifest, shapeProblems };
