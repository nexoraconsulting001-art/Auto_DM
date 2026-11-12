/** Pure: the report screens' rules, with no React Native, so the server's tests load it too. */

/** An email address checked by position, as the contract's RecipientAdd does: no pattern that a long address could stall. */
export const isEmail = (v) => {
  const s = String(v ?? '').trim();
  const at = s.indexOf('@');
  return s.length <= 254 && !/\s/.test(s) && at > 0 && at === s.lastIndexOf('@') && s.indexOf('.', at + 2) > 0 && !s.endsWith('.');
};

/** Pure: a new schedule from the form: the saved view, how often, the hour, and the weekday or day of the month. */
export function scheduleBody({ viewId, frequency, hourOfDay, weekday, dayOfMonth, format }) {
  if (!viewId) return { error: 'reports.scheduled.pickView' };
  const body = { viewId: Number(viewId), frequency, hourOfDay: Number(hourOfDay), format };
  if (frequency === 'weekly') body.weekday = Number(weekday);
  if (frequency === 'monthly') {
    const day = Number(dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 28) return { error: 'reports.scheduled.dayBad' };
    body.dayOfMonth = day;
  }
  return { body };
}
