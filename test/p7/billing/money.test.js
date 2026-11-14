// The arithmetic of Bhava's invoices in whole paise (PRD 5.12, F-54): no rounding drift, lines always add up to the total,
// and credit notes, however split, never give back more tax than was charged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apportion, creditLines, taxedLine, totalsOf } from '../../../src/modules/billing/money.js';

const rand = (() => {
  let seed = 7;
  return (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
})();

test('every line is whole paise; same state is CGST plus SGST in equal halves, another is IGST; totals are the sum of lines', () => {
  for (let i = 0; i < 2000; i++) {
    const gross = rand(10_000_000);
    const discount = rand(gross + 1);
    const intra = i % 2 === 0;
    const line = taxedLine({ kind: 'addon', code: 'x', description: 'x', grossPaise: gross, discountPaise: discount, rateBp: 1800, sellerState: '29', placeOfSupply: intra ? '29' : '07' });
    for (const key of ['taxablePaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'totalPaise']) assert.ok(Number.isSafeInteger(line[key]) && line[key] >= 0, key);
    assert.equal(line.taxablePaise, gross - discount);
    assert.equal(line.totalPaise, line.taxablePaise + line.cgstPaise + line.sgstPaise + line.igstPaise);
    if (intra) assert.ok(line.cgstPaise === line.sgstPaise && line.igstPaise === 0);
    else assert.ok(line.cgstPaise === 0 && line.sgstPaise === 0);
  }
  assert.throws(() => taxedLine({ kind: 'addon', code: 'x', description: 'x', grossPaise: 10.5, rateBp: 1800 }), /whole paise/);
  assert.throws(() => taxedLine({ kind: 'addon', code: 'x', description: 'x', grossPaise: 100, discountPaise: 101, rateBp: 1800 }), /discount/);
  const lines = [1, 2, 3, 4, 5].map((k) => taxedLine({ kind: 'addon', code: 'x', description: 'x', grossPaise: 333 * k, rateBp: 1800, sellerState: '29', placeOfSupply: '29' }));
  const totals = totalsOf(lines);
  assert.equal(totals.totalPaise, lines.reduce((s, l) => s + l.totalPaise, 0), 'tax per line, summed: never computed again on the total');
});

test('apportion splits exactly; credit notes in many parts give back exactly the tax charged, never more', () => {
  for (let i = 0; i < 300; i++) {
    const weights = Array.from({ length: 1 + rand(6) }, () => rand(100_000));
    const total = weights.reduce((a, b) => a + b, 0);
    const amount = rand(total + 1);
    const parts = apportion(amount, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), amount);
    parts.forEach((p, k) => assert.ok(p >= 0 && p <= weights[k]));
  }
  for (const intra of [true, false]) {
    const original = [1, 2, 3].map((k, i) => {
      const l = taxedLine({ kind: 'addon', code: `c${k}`, description: 'x', grossPaise: 49_999 * k + 7, rateBp: 1800, sellerState: '29', placeOfSupply: intra ? '29' : '27' });
      return { position: i + 1, kind: l.kind, code: l.code, description: l.description, sac: '', rate_bp: 1800, taxable_paise: l.taxablePaise, cgst_paise: l.cgstPaise, sgst_paise: l.sgstPaise, igst_paise: l.igstPaise };
    });
    const earlier = [];
    let left = original.reduce((s, l) => s + l.taxable_paise, 0);
    while (left > 0) {
      const amount = Math.min(left, 1 + rand(7777));
      const credit = creditLines({ original, earlier, amountPaise: amount, intra });
      assert.ok(credit);
      assert.equal(credit.reduce((s, l) => s + l.taxablePaise, 0), amount);
      for (const l of credit) earlier.push({ position: l.position, taxable_paise: l.taxablePaise, cgst_paise: l.cgstPaise, sgst_paise: l.sgstPaise, igst_paise: l.igstPaise });
      left -= amount;
    }
    for (const key of ['taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise']) {
      assert.equal(earlier.reduce((s, l) => s + l[key], 0), original.reduce((s, l) => s + l[key], 0), `${key}: credited exactly what was charged`);
    }
    assert.equal(creditLines({ original, earlier, amountPaise: 1, intra }), null, 'nothing left to credit');
  }
});
