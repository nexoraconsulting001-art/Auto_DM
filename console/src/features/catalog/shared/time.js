const two = (n) => String(n).padStart(2, '0');

/** A time from the API as a <input type="datetime-local"> holds it, in the seller's own time zone. '' for none. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** The other way: what the seller picked, as the API takes it. null for none; undefined when it isn't a date and time. */
export function fromLocalInput(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
