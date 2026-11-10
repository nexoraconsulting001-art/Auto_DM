// F-97 (PRD 5.18): one structure for every business. The policy check fails code that treats one business differently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFolders, checkSource } from '../../../tools/policy-check.mjs';

test('the product code treats no business differently', () => {
  assert.deepEqual(checkFolders(), []);
});

test('F-97: a check on a specific business id, slug or name fails the policy check', () => {
  const offenders = [
    "if (tenant.slug === 'mehtamart') return special();",
    'if (tenantId() === 3) discount = 10;',
    "const vip = business.name == 'Plant Store';",
    "if ('green-leaf' === req.tenant.slug) {}",
    'switch (tenant.slug) {',
    "if (['a-shop', 'b-shop'].includes(tenant.slug)) {}",
    "db.query('SELECT * FROM products WHERE tenant_id = 7')",
    "const url = 'https://offerwalebaba.example/api';",
  ];
  for (const line of offenders) assert.equal(checkSource(line, 'src/x.js').length, 1, line);
  assert.equal(checkSource("-- every business\nSELECT 1 FROM products WHERE tenant_id = 12;", 'src/db/migrations/999_x.sql').length, 1);
});

test('comments, data and ordinary comparisons pass', () => {
  const fine = [
    '// Mehta Mart\'s price bands are data now',
    '/* tenant.slug === "x" */ const a = 1;',
    'if (tenant.id === row.tenant_id) ok();',
    "if (user.role === 'owner') ok();",
    "const link = 'https://shop.example//path'; // a comment",
    "await tenants.ensure({ slug: 'default', name: 'Test store' });",
    'WHERE tenant_id = $1 AND id = $2',
  ];
  for (const line of fine) assert.deepEqual(checkSource(line, 'src/x.js'), [], line);
});
