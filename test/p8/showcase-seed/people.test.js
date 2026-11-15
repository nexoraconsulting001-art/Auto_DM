import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PEOPLE_RULES, SHOWCASE, inventedPerson, problemsWithPerson } from '../../../src/contracts/seed.js';
import { findOutsiders, scanDatabase, toE164 } from '../../../tools/sim/activity/people.mjs';
import { loadBoth } from './support.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const seedFolder = path.join(root, path.dirname(SHOWCASE.manifest));

test('Q-02 no seed file of the showcase holds a phone, an email or an Instagram name that is not invented', () => {
  const files = fs.readdirSync(seedFolder).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 4, 'the manifest, both businesses and the invented catalogue');
  for (const file of files) assert.deepEqual(findOutsiders(fs.readFileSync(path.join(seedFolder, file), 'utf8')), [], file);
});

test('Q-02 what the businesses load from, the catalogues, holds none either, and every person of a seed is invented', () => {
  for (const b of loadBoth()) {
    assert.deepEqual(findOutsiders(JSON.stringify(b.catalogue)), [], `${b.key}: the catalogue`);
    assert.deepEqual(findOutsiders(JSON.stringify(b.seed)), [], `${b.key}: the seed`);
    assert.deepEqual(problemsWithPerson(b.seed.business.owner), [], `${b.key}: the owner`);
    assert.match(b.seed.business.igUsername, PEOPLE_RULES.instagram.username);
    assert.match(b.seed.business.igUserId, PEOPLE_RULES.instagram.id);
  }
});

test('Q-02 the check catches what it is for: a real-looking number, address, handle or email in any text', () => {
  const kinds = (text) => findOutsiders(text).map((f) => f.kind).sort();
  assert.deepEqual(kinds('Call 98765 43210 now'), ['phone']);
  assert.deepEqual(kinds('WhatsApp +91 9820012345'), ['phone']);
  assert.deepEqual(kinds('write to someone@gmail.com'), ['email']);
  assert.deepEqual(kinds('follow @some.real.shop or instagram.com/real_shop_official'), ['handle']);
  assert.deepEqual(kinds('+919000001234 help@shop.example demo_asha_1 @demo_asha_1'), [], 'invented ones pass');
  for (const finding of findOutsiders('9820012345 someone@gmail.com @someone')) assert.deepEqual(Object.keys(finding).sort(), ['count', 'kind'], 'a finding never carries the value');
  assert.equal(toE164('9000000001'), '+919000000001');
  assert.equal(toE164('919000000001'), '+919000000001');
  assert.equal(toE164('12345'), null);
});

test('Q-02 inventedPerson makes people the rules accept, and the database scan names only where a stranger is', async () => {
  for (let n = 0; n < 480; n += 37) assert.deepEqual(problemsWithPerson(inventedPerson(n)), [], `person ${n}`);
  const rows = {
    orders: [{ v: '+919000000001' }, { v: '+919876543210' }],
    users: [{ v: 'demo_aarohi_1' }],
  };
  const query = async (sql) => {
    if (/information_schema/.test(sql)) return [{ table_name: 'orders', column_name: 'phone' }, { table_name: 'users', column_name: 'username' }, { table_name: 'orders', column_name: 'notes' }];
    const table = /FROM "(\w+)"/.exec(sql)[1];
    return rows[table];
  };
  const found = await scanDatabase(query);
  assert.deepEqual(found, [{ table: 'orders', column: 'phone', kind: 'phone', count: 1 }]);
  assert.equal(JSON.stringify(found).includes('9876'), false, 'the number itself is never in the finding');
});
