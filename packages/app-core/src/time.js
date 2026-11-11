/**
 * "5 min ago", "3 h ago", then a date, in the app's language. `t` is useStrings().t. A timestamp that cannot be read
 * shows nothing rather than a wrong time.
 */
export function formatWhen(t, value, { now = Date.now(), locale = 'en' } = {}) {
  const at = Date.parse(value ?? '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('time.days', { count: days });
  return formatDate(value, { locale });
}

/** A calendar date such as 12 December 2026, in the app's language. */
export function formatDate(value, { locale = 'en' } = {}) {
  const at = new Date(value ?? '');
  if (Number.isNaN(at.getTime())) return '';
  try {
    return at.toLocaleDateString(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
