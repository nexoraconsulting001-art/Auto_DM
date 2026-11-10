/**
 * safeFetch moved to src/platform/safe-fetch.js in Phase 3, where createSafeFetch adds the import profiles (8.3 to 8.9).
 * The Phase 1 names stay here so the site read (5.5) and its tests keep working unchanged.
 */
export { BlockedAddressError, MAX_PAGE_BYTES, assertFetchable, isPublicAddress, requestOnce, safeFetch } from '../../platform/safe-fetch.js';
