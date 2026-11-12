import { APP_LINK_PATHS } from '../../contracts/apps.js';

/**
 * The two verified-link files (PRD 10.12), built from one business's app_configs row and nothing else. Pure: the caller
 * reads the row and the plan, for the current business only.
 */
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
export const HANDLE_ALL_URLS = 'delegate_permission/common.handle_all_urls';

/** assetlinks.json, or null when this business has no Android app to verify (no plan, no package, or no fingerprint). */
export function assetLinksFile(row, { android }) {
  if (!android || !row?.android_package) return null;
  const fingerprints = (row.play_signing_sha256 ?? []).map((value) => String(value).toUpperCase()).filter((value) => FINGERPRINT.test(value));
  if (!fingerprints.length) return null;
  return [{
    relation: [HANDLE_ALL_URLS],
    target: { namespace: 'android_app', package_name: row.android_package, sha256_cert_fingerprints: [...new Set(fingerprints)] },
  }];
}

/** apple-app-site-association, or null when this business has no iOS app to verify (no plan, no team or no bundle id). */
export function appleSiteFile(row, { ios }) {
  if (!ios || !row?.apple_team_id || !row?.ios_bundle_id) return null;
  return {
    applinks: {
      details: [{
        appIDs: [`${row.apple_team_id}.${row.ios_bundle_id}`],
        components: [
          ...APP_LINK_PATHS.exclude.map((path) => ({ '/': path, exclude: true })),
          ...APP_LINK_PATHS.open.map((path) => ({ '/': path })),
        ],
      }],
    },
  };
}
