/**
 * What the install hint decides, as plain functions (Phase 8, Q-12): who is shown it, and which words to use.
 * Plain JavaScript so node's test runner can drive it.
 */

/** An iPhone or iPad running Safari: the only place the console is installed by hand (Share, then Add to Home Screen). */
export function isIosSafari(userAgent = '', maxTouchPoints = 0) {
  const ua = String(userAgent);
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1); // an iPad can say it is a Mac
  if (!ios) return false;
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua); // other iOS browsers cannot add to the home screen
}

/** Already running from the home screen. */
export const isStandalone = (target = globalThis) => {
  try {
    return Boolean(target.navigator?.standalone) || Boolean(target.matchMedia?.('(display-mode: standalone)')?.matches);
  } catch {
    return false;
  }
};

/** Whether to show the hint banner on its own: iPhone Safari, not installed, and not turned away before. */
export const shouldShowHint = ({ userAgent, maxTouchPoints, standalone, dismissed }) => isIosSafari(userAgent, maxTouchPoints) && !standalone && !dismissed;

export const IOS_STEPS = Object.freeze([
  'Open this page in Safari.',
  'Tap the Share button at the bottom of the screen.',
  'Scroll down and tap Add to Home Screen.',
  'Tap Add. Bhava is now on your home screen and opens full screen.',
]);

export const ANDROID_STEPS = Object.freeze([
  'Open this page in Chrome.',
  'Tap Install below, or open the menu and tap Install app.',
  'Bhava is now on your home screen.',
]);

export const HINT_KEY = 'bhava.install-hint';
export const INSTALL_PATH = '/admin/settings/install';
