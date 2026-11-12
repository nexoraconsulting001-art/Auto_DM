/**
 * The one place the app learns that its version is too old (the server answers 426 update_required). The browsing screens
 * report it here; the navigator then shows the update screen instead of the tabs. It holds the store link and nothing else.
 */
import { useSyncExternalStore } from 'react';

let current = null;
const listeners = new Set();

export function reportUpdateRequired(error) {
  if (current) return;
  current = { storeUrl: typeof error?.storeUrl === 'string' ? error.storeUrl : '' };
  listeners.forEach((listener) => listener());
}

/** For tests, and for the moment a newer version of the app starts. */
export function clearUpdateRequired() {
  current = null;
  listeners.forEach((listener) => listener());
}

export function useUpdateRequired() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => current, () => null);
}
