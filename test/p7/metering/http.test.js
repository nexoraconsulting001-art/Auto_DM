// billing.usage and the statement files on a running app: the owner's, Bhava's surface, one business at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingUsage } from '../../../src/contracts/api/billing.js';
import { withTenant } from '../../../src/tenancy.js';
import { usageFor } from '../../../src/modules/usage/index.js';
import { OWNER, startApp } from '../../helpers.js';

test('the live meter and the statement files answer the owner only, and only for the owner\'s own business', async () => {
  const app = await startApp();
  try {
    const { token } = await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json();
    const get = (pathname, bearer = token) => fetch(`${app.base}${pathname}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

    const service = usageFor(app.ctx);
    await withTenant(app.tenant, () => service.meter.record({ meter: 'dms', quantity: 120, key: 'http-test-batch' }));
    const res = await get('/api/v1/billing/usage');
    assert.equal(res.status, 200);
    const body = BillingUsage.parse(await res.json());
    assert.equal(body.meters.find((m) => m.meter === 'dms').used, 120);
    assert.equal(body.meters.find((m) => m.meter === 'dms').included, 500, 'the Free plan\'s 500');
    assert.equal((await get('/api/v1/billing/usage', null)).status, 401);

    // A statement for a closed month, then its files.
    const row = await withTenant(app.tenant, () => service.statements.run('2026-10-01'));
    assert.ok(row.pdf_key && row.csv_key);
    const csv = await get(`/billing/statement-files/s${row.id}.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /bhava-statement-2026-10\.csv/);
    assert.match(await csv.text(), /^Bhava settlement statement/);
    const pdf = await get(`/billing/statement-files/s${row.id}.pdf`);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await get(`/billing/statement-files/s${row.id}.pdf`, null)).status, 401, 'signed in only');
    assert.equal((await get(`/billing/statement-files/s${Number(row.id) + 1000}.pdf`)).status, 404);
    assert.equal((await get('/billing/statement-files/s1.exe')).status, 404);

    // Another business's statement is not found from this one's session.
    const other = await app.platform.tenants.create({ slug: `metering-http-${process.pid}`, name: 'Other' });
    const theirs = await withTenant(other, () => service.statements.run('2026-10-01'));
    assert.equal((await get(`/billing/statement-files/s${theirs.id}.csv`)).status, 404);
  } finally {
    app.close();
  }
});
