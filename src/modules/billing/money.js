import { offerDiscountPaise, taxFor } from '../../contracts/billing.js';

/**
 * The arithmetic of a Bhava invoice, in whole paise (PRD 5.12, F-54). Every line is taxed on its own with taxFor() from the
 * contract, and a document's totals are only ever the sum of its lines, so the two can never drift apart. Pure functions: no
 * database, no clock.
 */

const whole = (value, what) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be whole paise`);
  return value;
};

/** CGST and SGST when the place of supply is Bhava's own state, IGST otherwise (and when either state is unknown). */
export const isIntraState = (sellerState, placeOfSupply) => Boolean(sellerState) && sellerState === placeOfSupply;

/**
 * One invoice line with its tax. `grossPaise` is quantity times the unit price (or the cost, for a pass-through line), and
 * `discountPaise` what an offer takes off it.
 */
export function taxedLine({ kind, code, description, sac = '', quantity = 1, unitPaise = 0, grossPaise, discountPaise = 0, rateBp, sellerState, placeOfSupply, periodStart = null, periodEnd = null }) {
  whole(grossPaise, 'A line');
  whole(discountPaise, 'A discount');
  if (discountPaise > grossPaise) throw new Error('A discount cannot be more than the line');
  const taxablePaise = grossPaise - discountPaise;
  const tax = taxFor(taxablePaise, { rateBp, sellerState, buyerState: placeOfSupply });
  return {
    kind, code, description: String(description).slice(0, 200), sac, quantity, unitPaise, grossPaise, discountPaise, taxablePaise, rateBp,
    cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, totalPaise: tax.totalPaise, periodStart, periodEnd,
  };
}

/** A priced thing with an offer: the discount is the offer's share of the gross, half up. */
export const discountFor = (grossPaise, offer) => (offer ? offerDiscountPaise(grossPaise, offer.percentOff) : 0);

/** The totals of a document: always and only the sum of its lines. */
export function totalsOf(lines) {
  const sum = (key) => lines.reduce((total, line) => total + line[key], 0);
  const totals = { taxablePaise: sum('taxablePaise'), cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), igstPaise: sum('igstPaise') };
  return { ...totals, totalPaise: totals.taxablePaise + totals.cgstPaise + totals.sgstPaise + totals.igstPaise };
}

/**
 * Splits `amount` over `weights` in whole units, in proportion, by largest remainder: the parts always add up to `amount` and
 * no part is more than its weight. Ties go to the earlier weight, so the split is the same every time.
 */
export function apportion(amount, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (amount > total) throw new Error('Cannot split more than there is');
  if (total === 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((amount * w) / total));
  let left = amount - parts.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => ({ i, rest: (amount * w) % total })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (parts[i] < weights[i]) {
      parts[i] += 1;
      left -= 1;
    }
  }
  return parts;
}

/**
 * The lines of a credit note against an issued invoice: `amountPaise` of taxable value, spread over what is still uncredited of
 * each original line, with tax in the original's regime. A line credited in full gives back exactly the tax still on it, so a
 * series of partial credits never returns more tax than the invoice charged. `original` and `earlier` are lines as the
 * database keeps them (snake_case); `earlier` are the lines of earlier credit notes for the same invoice.
 */
export function creditLines({ original, earlier = [], amountPaise, intra }) {
  whole(amountPaise, 'A credit');
  const left = original.map((line) => {
    const prior = earlier.filter((e) => Number(e.position) === Number(line.position));
    const used = (key) => prior.reduce((total, e) => total + Number(e[key]), 0);
    return {
      line,
      taxable: Number(line.taxable_paise) - used('taxable_paise'),
      cgst: Number(line.cgst_paise) - used('cgst_paise'),
      sgst: Number(line.sgst_paise) - used('sgst_paise'),
      igst: Number(line.igst_paise) - used('igst_paise'),
    };
  });
  const remaining = left.reduce((total, l) => total + l.taxable, 0);
  if (amountPaise <= 0 || amountPaise > remaining) return null;
  const shares = apportion(amountPaise, left.map((l) => l.taxable));
  const lines = [];
  left.forEach((l, i) => {
    const taxable = shares[i];
    if (taxable <= 0) return;
    let cgst;
    let sgst;
    let igst;
    if (taxable === l.taxable) {
      ({ cgst, sgst, igst } = l);
    } else {
      const rate = Number(l.line.rate_bp);
      const tax = taxFor(taxable, intra ? { rateBp: rate, sellerState: 'same', buyerState: 'same' } : { rateBp: rate });
      cgst = Math.min(tax.cgstPaise, l.cgst);
      sgst = Math.min(tax.sgstPaise, l.sgst);
      igst = Math.min(tax.igstPaise, l.igst);
    }
    lines.push({
      position: Number(l.line.position), kind: l.line.kind, code: l.line.code, description: `Credit: ${l.line.description}`.slice(0, 200), sac: l.line.sac ?? '',
      quantity: 1, unitPaise: taxable, grossPaise: taxable, discountPaise: 0, taxablePaise: taxable, rateBp: Number(l.line.rate_bp),
      cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, totalPaise: taxable + cgst + sgst + igst, periodStart: null, periodEnd: null,
    });
  });
  return lines;
}

/** Rupees for a document: "Rs. 1,234.50" (Indian grouping). */
export function rupees(paise) {
  const value = Number(paise);
  const abs = Math.abs(value);
  return `${value < 0 ? '-' : ''}Rs. ${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}
