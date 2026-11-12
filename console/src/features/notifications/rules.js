/**
 * The notification screens' rules (PRD 5.13, 10.5), with no React, so node's test runner reads them. The server
 * checks every choice again (prefProblem, QuietHours in src/contracts) and its answer is what the screen shows.
 */
export const CHANNELS = Object.freeze(['push', 'email', 'whatsapp']);
export const CHANNEL_LABELS = Object.freeze({ push: 'Push to the app', email: 'Email', whatsapp: 'WhatsApp' });

/** The clock format quiet hours use (QuietHours.from and .to). */
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Field errors for quiet hours, as { from?, to? }. From and to may cross midnight (22:00 to 07:00); they may not be the same. */
export function quietHoursProblems({ enabled, from, to }) {
  const problems = {};
  if (!CLOCK.test(from ?? '')) problems.from = 'Use a time such as 22:00';
  if (!CLOCK.test(to ?? '')) problems.to = 'Use a time such as 07:00';
  if (enabled && !problems.from && !problems.to && from === to) problems.to = 'Choose a different time from the start';
  return problems;
}

/** "From 22:00 to 07:00 the next morning", for the screen. */
export function quietHoursText({ enabled, from, to }) {
  if (!enabled) return 'Off: push and WhatsApp come at any hour.';
  return `On: from ${from} to ${to}${to <= from ? ' the next morning' : ''}, push and WhatsApp wait. Urgent alerts still come through.`;
}

/** Time zones to choose from: the browser's list, with the saved one and India's always in it. */
export function timezoneChoices(saved, intl = globalThis.Intl) {
  let zones = [];
  try {
    zones = intl?.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  return [...new Set([saved, 'Asia/Kolkata', ...zones].filter(Boolean))].sort();
}

/**
 * The page a notification opens inside the console, or null when it opens nothing more than the list. Links are paths
 * (isLinkPath in src/contracts/notifications.js). `pages` are the console's route paths ('orders/:id', 'settings/team'):
 * a link to something the console has no page for (one only the app has) opens nothing, rather than a missing page.
 */
const LINK_PATH = /^\/[a-z0-9][a-z0-9/_-]{0,190}$/;
export function linkInConsole(link, pages) {
  if (typeof link !== 'string' || link === '/' || !LINK_PATH.test(link) || link.includes('//')) return null;
  if (pages && !pages.some((page) => pathMatches(page, link))) return null;
  return link;
}

/** Whether a route path ('orders/:id', 'settings/*') matches a path ('/orders/12'), segment by segment. */
export function pathMatches(pattern, path) {
  const want = String(pattern ?? '').split('/').filter(Boolean);
  const have = String(path ?? '').split('/').filter(Boolean);
  for (let i = 0; i < want.length; i++) {
    if (want[i] === '*') return true;
    if (i >= have.length) return false;
    if (want[i].startsWith(':')) continue;
    if (want[i] !== have[i]) return false;
  }
  return want.length === have.length;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now", "5 min ago", "3 h ago", "Yesterday", or a date. */
export function whenText(at, now = Date.now()) {
  const then = new Date(at).getTime();
  const gone = Math.max(0, now - then);
  if (gone < MINUTE) return 'Just now';
  if (gone < HOUR) return `${Math.floor(gone / MINUTE)} min ago`;
  if (gone < DAY) return `${Math.floor(gone / HOUR)} h ago`;
  if (gone < 2 * DAY) return 'Yesterday';
  return new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** The body of notifications.savePrefs for one switch. */
export const choiceBody = (kind, channel, enabled) => ({ events: { [kind]: { [channel]: enabled } } });

/** The saved choices with one switch changed, for showing it before the server answers. */
export function withChoice(prefs, kind, channel, enabled) {
  return { ...prefs, events: { ...prefs.events, [kind]: { ...prefs.events[kind], [channel]: enabled } } };
}
