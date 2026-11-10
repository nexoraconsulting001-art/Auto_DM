/** Money is integer paise everywhere. These two are the only places rupees appear. */
export function formatPaise(paise) {
  const rupees = (paise ?? 0) / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "499", "499.5" or "1,299.00" to paise, without going through a floating-point rupee amount. Empty is null; not a price is NaN. */
export function rupeesToPaise(value) {
  const input = String(value ?? '').replace(/[,₹\s]/g, '');
  if (input === '') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input);
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export const paiseToRupees = (paise) => (paise === null || paise === undefined ? '' : String(paise / 100));

export function formatDateTime(value) {
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
