/** Pure: a reel's window in a category as the phone types it, with no React Native, so the server's tests load it too. */

/** "2026-11-05" typed on the phone as the start of that day where the phone is, as the API's ISO time; '' is none. */
export function dayToIso(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getMonth() !== Number(match[2]) - 1) return undefined;
  return date.toISOString();
}
/** An ISO time as the day it falls on where the phone is, for the field. */
export function isoToDay(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
