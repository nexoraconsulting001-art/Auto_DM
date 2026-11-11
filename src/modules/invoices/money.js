import { splitGst, taxInside } from '../../contracts/orders.js';

/**
 * The money of a GST invoice and its credit notes (PRD 9.13), in whole paise. Pure: no database, no clock.
 *
 * Prices include GST. Each line's value is what the shopper paid for it after its share of the coupon (9.14: GST on the
 * discounted value), and the tax inside it is taxInside(value, rate), split CGST and SGST when the seller and the place of
 * supply are in the same state and IGST otherwise (splitGst). The invoice's totals are the sums of its lines, so
 *   total = taxable + CGST + SGST + IGST   on every line and on the whole document, to the paisa.
 *
 * Without a GSTIN the document is a bill of supply: the same lines with no tax on them.
 *
 * Delivery and the cash-on-delivery fee are lines of their own. How GST applies to them is still to confirm with a CA
 * (9.13); until then they follow the principal supply (the goods line of the highest value), the usual reading for a
 * composite supply. CHARGES_FOLLOW is the one place to change that ('principal' or 'none').
 *
 * A credit note gives back part of the invoice. Its amount is spread over the invoice's lines (the returned lines first,
 * when the refund is for a return), never more than what is left of a line after earlier credit notes. The tax of each
 * part is the difference the part makes to the tax inside everything credited on that line so far, so a line credited in
 * full, in one note or many, gives back exactly the tax the invoice charged on it.
 */
export const CHARGES_FOLLOW = 'principal';
/** SAC 996812: courier services. Shown on the delivery and COD fee lines. */
export const CHARGE_SAC = '996812';

const isPaise = (n) => Number.isSafeInteger(n) && n >= 0;
const valueOf = (line) => line.grossPaise - (line.discountPaise ?? 0);

/** Whether a sale is inside one state: CGST and SGST then, IGST otherwise. Unknown seller state counts as another state. */
const sameState = (sellerState, placeOfSupply) => Boolean(sellerState) && String(sellerState) === String(placeOfSupply);

function taxed({ value, rateBp, registered, sellerState, placeOfSupply }) {
  if (!registered || rateBp === 0) return { taxablePaise: value, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
  const { taxablePaise, taxPaise } = taxInside(value, rateBp);
  return { taxablePaise, ...splitGst(taxPaise, { sellerState: sameState(sellerState, placeOfSupply) ? sellerState : '', buyerState: placeOfSupply }) };
}

/**
 * The lines of an invoice or bill of supply for an order.
 *   items         the order's lines as sold: [{ id, name, option, hsn, qty, pricePaise, discountPaise, rateBp }]
 *   shippingPaise, codFeePaise   the order's charges
 *   registered    the seller has a GSTIN
 *   sellerState, placeOfSupply   two-digit state codes
 */
export function invoiceLines({ items, shippingPaise = 0, codFeePaise = 0, registered, sellerState, placeOfSupply }) {
  if (!Array.isArray(items) || !items.length) throw new RangeError('An invoice needs at least one line');
  const where = { registered, sellerState, placeOfSupply };
  const goods = items.map((item) => {
    const qty = Number(item.qty);
    const grossPaise = Number(item.pricePaise) * qty;
    const discountPaise = Number(item.discountPaise ?? 0);
    const rateBp = registered ? Number(item.rateBp ?? 0) : 0;
    if (!Number.isInteger(qty) || qty <= 0 || !isPaise(grossPaise) || !isPaise(discountPaise) || discountPaise > grossPaise) throw new RangeError('An order line has impossible amounts');
    if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) throw new RangeError('GST rate is 0 to 10000 basis points');
    const description = [item.name, item.option].map((s) => String(s ?? '').trim()).filter(Boolean).join(' - ');
    return {
      kind: 'goods',
      orderItemId: item.id ?? null,
      description: description.slice(0, 200) || 'Item',
      hsn: String(item.hsn ?? ''),
      qty,
      grossPaise,
      discountPaise,
      rateBp,
      ...taxed({ value: grossPaise - discountPaise, rateBp, ...where }),
    };
  });
  const principal = [...goods].sort((a, b) => valueOf(b) - valueOf(a) || b.rateBp - a.rateBp)[0];
  const chargeRate = registered && CHARGES_FOLLOW === 'principal' ? principal.rateBp : 0;
  const charge = (description, amount) => ({
    kind: 'charge', orderItemId: null, description, hsn: CHARGE_SAC, qty: 1, grossPaise: amount, discountPaise: 0, rateBp: chargeRate,
    ...taxed({ value: amount, rateBp: chargeRate, ...where }),
  });
  const lines = [...goods];
  for (const [description, amount] of [['Delivery', Number(shippingPaise)], ['Cash on delivery fee', Number(codFeePaise)]]) {
    if (!isPaise(amount)) throw new RangeError('A charge is whole paise, zero or more');
    if (amount > 0) lines.push(charge(description, amount));
  }
  return lines;
}

/** The document's totals: the sums of its lines. */
export function totalsOf(lines) {
  const sum = (key) => lines.reduce((total, line) => total + line[key], 0);
  const out = { taxablePaise: sum('taxablePaise'), cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), igstPaise: sum('igstPaise') };
  return { ...out, totalPaise: out.taxablePaise + out.cgstPaise + out.sgstPaise + out.igstPaise };
}

/**
 * Splits `amount` over `weights` in proportion, in whole units, each part at most its cap (the weight, unless `caps` says
 * less). Largest remainders get the leftover units, earliest first on a tie. The parts add up to the amount exactly when
 * the caps allow it; what doesn't fit is returned as `left`.
 */
export function apportion(amount, weights, caps = weights) {
  const parts = weights.map(() => 0);
  const base = weights.reduce((a, w) => a + w, 0);
  if (amount <= 0 || base <= 0) return { parts, left: Math.max(0, amount) };
  const want = Math.min(amount, caps.reduce((a, c) => a + c, 0));
  const rest = [];
  let given = 0;
  weights.forEach((w, i) => {
    if (w <= 0 || caps[i] <= 0) return;
    const exact = BigInt(want) * BigInt(w);
    parts[i] = Math.min(caps[i], Number(exact / BigInt(base)));
    given += parts[i];
    rest.push({ i, r: Number(exact % BigInt(base)) });
  });
  rest.sort((a, b) => b.r - a.r || a.i - b.i);
  // Every pass gives a unit to some line still under its cap, so this ends.
  while (given < want && rest.length) {
    let moved = false;
    for (const { i } of rest) {
      if (given >= want) break;
      if (parts[i] < caps[i]) {
        parts[i] += 1;
        given += 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { parts, left: amount - given };
}

/**
 * The lines of a credit note against `invoice`.
 *   invoice     { lines, placeOfSupply, sellerState, registered } (the invoice as issued)
 *   earlier     the lines of every earlier credit note against it (each names its invoice line in `line`)
 *   amountPaise what is given back
 *   prefer      { [invoice line index]: paise } to credit first: the returned units of a return, at their share of the line
 *   qty         { [invoice line index]: units } returned, shown on the note
 * Throws when the amount is more than what is left of the invoice.
 */
export function creditNoteLines({ invoice, earlier = [], amountPaise, prefer = {}, qty = {} }) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new RangeError('A credit note is for a whole number of paise, more than zero');
  const lines = invoice.lines;
  const credited = lines.map(() => 0);
  const creditedTax = lines.map(() => ({ cgst: 0, sgst: 0, igst: 0 }));
  for (const old of earlier) {
    const i = Number(old.line);
    if (!Number.isInteger(i) || i < 0 || i >= lines.length) continue;
    credited[i] += old.grossPaise;
  }
  const room = lines.map((line, i) => Math.max(0, valueOf(line) - credited[i]));
  if (amountPaise > room.reduce((a, b) => a + b, 0)) throw new RangeError('That is more than is left to credit on this invoice');

  // The returned lines first, at most their returned share; then whatever is left over every line, by what is left of it.
  const preferCaps = lines.map((_, i) => Math.min(room[i], Math.max(0, Math.floor(Number(prefer[i] ?? 0)))));
  const first = apportion(amountPaise, preferCaps, preferCaps);
  const afterFirst = room.map((r, i) => r - first.parts[i]);
  const second = apportion(first.left, afterFirst, afterFirst);
  if (second.left) throw new RangeError('That is more than is left to credit on this invoice');
  const parts = lines.map((_, i) => first.parts[i] + second.parts[i]);

  // Tax given back on a line is what the part adds to the tax inside everything credited on it: never a paisa more or less overall.
  for (const old of earlier) {
    const i = Number(old.line);
    if (!Number.isInteger(i) || i < 0 || i >= lines.length) continue;
    creditedTax[i].cgst += old.cgstPaise;
    creditedTax[i].sgst += old.sgstPaise;
    creditedTax[i].igst += old.igstPaise;
  }
  const where = { registered: invoice.registered, sellerState: invoice.sellerState, placeOfSupply: invoice.placeOfSupply };
  const out = [];
  lines.forEach((line, i) => {
    const part = parts[i];
    if (!part) return;
    // Tax inside a tax-inclusive amount never falls as the amount grows, so these differences are never negative and never
    // more than the part. Earlier notes made some other way could break that: then the part is taxed on its own.
    const after = taxed({ value: credited[i] + part, rateBp: line.rateBp, ...where });
    let cgstPaise = after.cgstPaise - creditedTax[i].cgst;
    let sgstPaise = after.sgstPaise - creditedTax[i].sgst;
    let igstPaise = after.igstPaise - creditedTax[i].igst;
    if (cgstPaise < 0 || sgstPaise < 0 || igstPaise < 0 || cgstPaise + sgstPaise + igstPaise > part) {
      ({ cgstPaise, sgstPaise, igstPaise } = taxed({ value: part, rateBp: line.rateBp, ...where }));
    }
    const taxes = { taxablePaise: part - cgstPaise - sgstPaise - igstPaise, cgstPaise, sgstPaise, igstPaise };
    out.push({
      line: i,
      kind: line.kind,
      orderItemId: line.orderItemId ?? null,
      description: line.description,
      hsn: line.hsn,
      qty: Math.max(0, Math.floor(Number(qty[i] ?? 0))),
      grossPaise: part,
      discountPaise: 0,
      rateBp: line.rateBp,
      taxablePaise: taxes.taxablePaise,
      cgstPaise: taxes.cgstPaise,
      sgstPaise: taxes.sgstPaise,
      igstPaise: taxes.igstPaise,
    });
  });
  return out;
}
