// The console's rupee helpers are the only place a form's rupees become paise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPaise, paiseToRupees, rupeesToPaise } from '../../../console/src/lib/format.js';

test('rupees typed in a form become exact paise', () => {
  const cases = { 499: 49900, '499.5': 49950, '1,299.00': 129900, '₹ 19.99': 1999, '0.07': 7, '1.10': 110, '4.35': 435, '0': 0 };
  for (const [typed, paise] of Object.entries(cases)) assert.equal(rupeesToPaise(typed), paise, typed);
  assert.equal(rupeesToPaise(''), null);
  assert.equal(rupeesToPaise(null), null);
  for (const bad of ['abc', '1.234', '-5', '1e3', '1.2.3']) assert.ok(Number.isNaN(rupeesToPaise(bad)), bad);
});

test('paise show as Indian rupees and go back into a form unchanged', () => {
  assert.equal(formatPaise(18642000), '₹1,86,420');
  assert.equal(formatPaise(129950), '₹1,299.50');
  assert.equal(formatPaise(null), '₹0');
  assert.equal(paiseToRupees(null), '');
  for (const paise of [0, 7, 110, 435, 1999, 49950, 2147483647]) assert.equal(rupeesToPaise(paiseToRupees(paise)), paise);
});
