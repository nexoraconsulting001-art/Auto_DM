// PRD 9.13: the money of an invoice and its credit notes, as pure functions. Exact in paise; every part adds up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { splitGst, taxInside } from '../../../src/contracts/orders.js';
import { CHARGE_SAC, apportion, creditNoteLines, invoiceLines, totalsOf } from '../../../src/modules/invoices/money.js';

const item = (pricePaise, rateBp, extra = {}) => ({ id: extra.id ?? 1, name: 'Cotton kurta', option: '', hsn: '6109', qty: 1, pricePaise, discountPaise: 0, rateBp, ...extra });
const value = (l) => l.grossPaise - l.discountPaise;
const taxes = (l) => l.cgstPaise + l.sgstPaise + l.igstPaise;

test('S-42: Delhi to Delhi at 5%, Rs 1,050 inclusive is taxable Rs 1,000 with CGST Rs 25 and SGST Rs 25', () => {
  const [line] = invoiceLines({ items: [item(105000, 500)], registered: true, sellerState: '07', placeOfSupply: '07' });
  assert.deepEqual([line.taxablePaise, line.cgstPaise, line.sgstPaise, line.igstPaise], [100000, 2500, 2500, 0]);
  assert.equal(line.hsn, '6109');
  assert.equal(line.rateBp, 500);
  assert.deepEqual(totalsOf([line]), { taxablePaise: 100000, cgstPaise: 2500, sgstPaise: 2500, igstPaise: 0, totalPaise: 105000 });
});

test('S-42: another state is IGST only, and an odd tax splits CGST down and SGST up', () => {
  const [inter] = invoiceLines({ items: [item(105000, 500)], registered: true, sellerState: '07', placeOfSupply: '27' });
  assert.deepEqual([inter.cgstPaise, inter.sgstPaise, inter.igstPaise], [0, 0, 5000]);
  // 18% inside Rs 999: tax 15239 paise, an odd number.
  const [odd] = invoiceLines({ items: [item(99900, 1800)], registered: true, sellerState: '07', placeOfSupply: '07' });
  const { taxablePaise, taxPaise } = taxInside(99900, 1800);
  assert.equal(odd.taxablePaise, taxablePaise);
  assert.deepEqual([odd.cgstPaise, odd.sgstPaise], [Math.floor(taxPaise / 2), taxPaise - Math.floor(taxPaise / 2)]);
  // No seller state on record: never CGST and SGST.
  const [unknown] = invoiceLines({ items: [item(105000, 500)], registered: true, sellerState: '', placeOfSupply: '07' });
  assert.equal(unknown.igstPaise, 5000);
});

test('S-42: GST is on the discounted value, and quantities multiply before the tax is taken out', () => {
  const [line] = invoiceLines({ items: [item(105000, 500, { discountPaise: 10500 })], registered: true, sellerState: '07', placeOfSupply: '07' });
  assert.equal(line.taxablePaise, 90000);
  assert.equal(taxes(line), 4500);
  const [mugs] = invoiceLines({ items: [item(33300, 1200, { qty: 3 })], registered: true, sellerState: '07', placeOfSupply: '07' });
  assert.equal(mugs.grossPaise, 99900);
  assert.equal(mugs.taxablePaise, taxInside(99900, 1200).taxablePaise);
  assert.throws(() => invoiceLines({ items: [item(1000, 500, { discountPaise: 1001 })], registered: true, sellerState: '07', placeOfSupply: '07' }), RangeError);
  assert.throws(() => invoiceLines({ items: [item(1000, 10001)], registered: true, sellerState: '07', placeOfSupply: '07' }), RangeError);
  assert.throws(() => invoiceLines({ items: [], registered: true }), RangeError);
});

test('without a GSTIN every line carries no tax: a bill of supply', () => {
  const lines = invoiceLines({ items: [item(105000, 500), item(49900, 1800, { id: 2 })], shippingPaise: 4900, registered: false, sellerState: '', placeOfSupply: '27' });
  for (const l of lines) {
    assert.equal(taxes(l), 0);
    assert.equal(l.rateBp, 0);
    assert.equal(l.taxablePaise, value(l));
  }
  assert.equal(totalsOf(lines).totalPaise, 105000 + 49900 + 4900);
});

test('delivery and the COD fee are lines of their own at the principal supply’s rate, and the total is everything paid', () => {
  const lines = invoiceLines({ items: [item(49900, 1200), item(105000, 500, { id: 2 })], shippingPaise: 4900, codFeePaise: 2500, registered: true, sellerState: '27', placeOfSupply: '27' });
  const charges = lines.filter((l) => l.kind === 'charge');
  assert.deepEqual(charges.map((c) => [c.description, c.grossPaise, c.rateBp, c.hsn]), [['Delivery', 4900, 500, CHARGE_SAC], ['Cash on delivery fee', 2500, 500, CHARGE_SAC]]);
  const totals = totalsOf(lines);
  assert.equal(totals.totalPaise, 49900 + 105000 + 4900 + 2500);
  assert.equal(totals.taxablePaise + totals.cgstPaise + totals.sgstPaise + totals.igstPaise, totals.totalPaise);
  assert.equal(invoiceLines({ items: [item(1000, 500)], shippingPaise: 0, registered: true, sellerState: '27', placeOfSupply: '27' }).length, 1, 'A free delivery is no line');
});

test('S-42: any basket, any rates, any states: each line and the whole document add up to the paisa', () => {
  const rates = [0, 300, 500, 1200, 1800, 2800];
  fc.assert(fc.property(
    fc.array(fc.record({ pricePaise: fc.integer({ min: 0, max: 5_000_000 }), qty: fc.integer({ min: 1, max: 10 }), rate: fc.constantFrom(...rates), off: fc.double({ min: 0, max: 1, noNaN: true }) }), { minLength: 1, maxLength: 8 }),
    fc.integer({ min: 0, max: 20000 }),
    fc.boolean(),
    fc.boolean(),
    (lines, shipping, registered, same) => {
      const items = lines.map((l, i) => ({ id: i + 1, name: `Line ${i}`, hsn: '6109', qty: l.qty, pricePaise: l.pricePaise, rateBp: l.rate, discountPaise: Math.floor(l.pricePaise * l.qty * l.off) }));
      const out = invoiceLines({ items, shippingPaise: shipping, registered, sellerState: '07', placeOfSupply: same ? '07' : '27' });
      for (const l of out) {
        assert.ok([l.taxablePaise, l.cgstPaise, l.sgstPaise, l.igstPaise].every((n) => Number.isSafeInteger(n) && n >= 0));
        assert.equal(l.taxablePaise + taxes(l), value(l));
        if (l.igstPaise) assert.equal(l.cgstPaise + l.sgstPaise, 0);
        if (registered && l.rateBp) {
          const tax = taxInside(value(l), l.rateBp).taxPaise;
          assert.deepEqual([l.cgstPaise, l.sgstPaise, l.igstPaise], Object.values(splitGst(tax, { sellerState: '07', buyerState: same ? '07' : '27' })));
        }
      }
      const totals = totalsOf(out);
      assert.equal(totals.totalPaise, items.reduce((s, i) => s + i.pricePaise * i.qty - i.discountPaise, 0) + shipping);
    },
  ), { numRuns: 300 });
});

test('apportion splits exactly, by weight, never past a cap', () => {
  assert.deepEqual(apportion(100, [50, 50, 50]).parts, [34, 33, 33]);
  assert.deepEqual(apportion(10, [5, 0, 5]).parts, [5, 0, 5]);
  const capped = apportion(10, [1, 1], [3, 100]);
  assert.equal(capped.parts[0], 3);
  assert.equal(capped.parts[1], 7);
  assert.equal(apportion(10, [2, 2]).left, 6, 'what the caps can’t hold is left over');
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1e7 }), { minLength: 1, maxLength: 10 }), fc.integer({ min: 0, max: 5e7 }), (weights, amount) => {
    const { parts, left } = apportion(amount, weights);
    parts.forEach((p, i) => assert.ok(p >= 0 && p <= weights[i]));
    assert.equal(parts.reduce((a, b) => a + b, 0) + left, amount);
  }), { numRuns: 300 });
});

const invoiceOf = (lines, { registered = true, sellerState = '07', placeOfSupply = '07' } = {}) => ({ lines, registered, sellerState, placeOfSupply });

test('a credit note for part of an invoice is spread over its lines, with the tax inside each part', () => {
  const lines = invoiceLines({ items: [item(99900, 500)], registered: true, sellerState: '27', placeOfSupply: '27' });
  const note = creditNoteLines({ invoice: invoiceOf(lines, { sellerState: '27', placeOfSupply: '27' }), amountPaise: 20000 });
  assert.equal(note.length, 1);
  assert.equal(totalsOf(note).totalPaise, 20000);
  assert.equal(note[0].taxablePaise, taxInside(20000, 500).taxablePaise);
  assert.equal(note[0].line, 0);
  assert.throws(() => creditNoteLines({ invoice: invoiceOf(lines), amountPaise: 99901 }), RangeError, 'more than the invoice');
  assert.throws(() => creditNoteLines({ invoice: invoiceOf(lines), amountPaise: 0 }), RangeError);
});

test('credit notes never credit a line twice, and crediting all of it in any pieces gives back exactly its tax', () => {
  fc.assert(fc.property(
    fc.array(fc.record({ pricePaise: fc.integer({ min: 1, max: 300_000 }), qty: fc.integer({ min: 1, max: 4 }), rate: fc.constantFrom(0, 500, 1200, 1800, 2800) }), { minLength: 1, maxLength: 5 }),
    fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), { minLength: 1, maxLength: 6 }),
    fc.boolean(),
    (rows, cuts, same) => {
      const where = { registered: true, sellerState: '07', placeOfSupply: same ? '07' : '29' };
      const lines = invoiceLines({ items: rows.map((r, i) => ({ id: i + 1, name: `L${i}`, qty: r.qty, pricePaise: r.pricePaise, rateBp: r.rate, discountPaise: 0 })), shippingPaise: 4900, ...where });
      const invoice = invoiceOf(lines, where);
      const total = totalsOf(lines).totalPaise;
      const earlier = [];
      let left = total;
      for (const cut of cuts) {
        if (!left) break;
        const amount = Math.max(1, Math.min(left, Math.floor(left * cut)));
        const note = creditNoteLines({ invoice, earlier, amountPaise: amount });
        assert.equal(totalsOf(note).totalPaise, amount);
        for (const l of note) assert.equal(l.taxablePaise + taxes(l), l.grossPaise);
        earlier.push(...note);
        left -= amount;
      }
      // What is left, in one last note: the whole invoice is then credited, to the paisa and to the tax.
      if (left) earlier.push(...creditNoteLines({ invoice, earlier, amountPaise: left }));
      const credited = totalsOf(earlier);
      assert.deepEqual(credited, totalsOf(lines));
      lines.forEach((l, i) => assert.equal(earlier.filter((e) => e.line === i).reduce((s, e) => s + e.grossPaise, 0), value(l)));
      assert.throws(() => creditNoteLines({ invoice, earlier, amountPaise: 1 }), RangeError, 'nothing is left to credit');
    },
  ), { numRuns: 200 });
});

test('a refund for a return credits the returned units first, and only what is over them goes elsewhere', () => {
  const items = [item(99900, 500, { id: 11, qty: 2 }), item(50000, 1200, { id: 12 })];
  const lines = invoiceLines({ items, registered: true, sellerState: '27', placeOfSupply: '27' });
  const invoice = invoiceOf(lines, { sellerState: '27', placeOfSupply: '27' });
  const one = creditNoteLines({ invoice, amountPaise: 99900, prefer: { 0: 99900 }, qty: { 0: 1 } });
  assert.deepEqual(one.map((l) => [l.line, l.grossPaise, l.qty]), [[0, 99900, 1]]);
  const over = creditNoteLines({ invoice, amountPaise: 109900, prefer: { 0: 99900 } });
  const first = over.find((l) => l.line === 0);
  assert.ok(first.grossPaise >= 99900, 'The returned line was not credited first');
  assert.equal(totalsOf(over).totalPaise, 109900);
});
