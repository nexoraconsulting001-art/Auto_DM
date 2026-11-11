// PRD 9.13: GST invoices issued from order events, numbered by the database, frozen once issued, corrected by credit notes,
// drawn as PDFs by the queue and kept in storage. Each test has its own app and database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financialYear, financialYearLabel } from '../../../src/contracts/orders.js';
import { PDF_QUEUE, invoicesFor, pdfJob } from '../../../src/modules/invoices/index.js';
import { PLATFORM_NAME, openWorld, raw } from './support.js';

const fyLabel = financialYearLabel(financialYear(new Date()));
const docs = async (shop, orderId) => (await shop.invoices(orderId)).filter((i) => i.doc_type !== 'credit_note');

test('S-42: a paid prepaid order gets one tax invoice, Delhi to Delhi at 5%, with its number, lines and event', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  assert.equal((await shop.invoiceSettings({ legalName: 'Lamp House Traders', gstin: '07ABCDE1234F1Z5', address: '4 Mill Lane, Delhi', invoicePrefix: 'LH' })).status, 200);
  const kurta = await shop.product({ pricePaise: 105000, gstRateBp: 500, hsn: '6109' });
  const order = await shop.placeOrder({ lines: [{ product: kurta }], stateCode: '07' });
  assert.equal((await shop.invoices(order.id)).length, 0, 'An invoice before payment');
  await shop.pay(order);
  const [inv] = await shop.invoices(order.id);
  assert.ok(inv, 'No invoice on payment');
  assert.equal(inv.doc_type, 'invoice');
  assert.equal(inv.number, `LH/${fyLabel}/00001`);
  assert.equal(inv.place_of_supply, '07');
  assert.deepEqual([inv.taxable_paise, inv.cgst_paise, inv.sgst_paise, inv.igst_paise, inv.total_paise].map(Number), [100000, 2500, 2500, 0, 105000]);
  assert.equal(inv.seller.gstin, '07ABCDE1234F1Z5');
  assert.equal(inv.seller.stateCode, '07', 'The state follows the GSTIN');
  assert.equal(inv.buyer.stateCode, '07');
  assert.deepEqual(inv.lines.map((l) => [l.hsn, l.rateBp, l.taxablePaise]), [['6109', 500, 100000]]);
  const events = await shop.sql(`SELECT type, entity, entity_id FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND type = 'invoice.issued'`, [shop.tenant.id, order.id]);
  assert.deepEqual(events.map((e) => [e.entity, Number(e.entity_id)]), [['invoice', Number(inv.id)]]);

  // The same event again, and asking directly, issue nothing new.
  await shop.inTenant(() => invoicesFor(world.ctx).issueFor(order.id));
  await shop.inTenant(() => invoicesFor(world.ctx).onEvent({ type: 'order.paid', orderId: order.id, entity: 'order', entityId: order.id }));
  assert.equal((await shop.invoices(order.id)).length, 1);

  const api = await shop.api('GET', `/invoices?orderId=${order.id}`);
  assert.equal(api.status, 200);
  assert.deepEqual(api.json.items.map((i) => [i.number, i.cgstPaise, i.sgstPaise, i.docType]), [[inv.number, 2500, 2500, 'invoice']]);
  assert.equal((await shop.api('GET', `/invoices/${inv.id}`)).json.totalPaise, 105000);
});

test('S-42: across states it is IGST, a coupon lowers the taxable value, delivery is its own line, and the parts add up', async (t) => {
  const { shop } = await openWorld(t);
  await shop.invoiceSettings({ gstin: '27ABCDE1234F1Z5' });
  const a = await shop.product({ pricePaise: 105000, gstRateBp: 500 });
  const b = await shop.product({ pricePaise: 33300, gstRateBp: 1200, hsn: '6912' });
  const order = await shop.placeOrder({ lines: [{ product: a }, { product: b, qty: 3 }], discounts: [10500, 0], shippingPaise: 4900, stateCode: '07' });
  await shop.pay(order);
  const [inv] = await shop.invoices(order.id);
  assert.equal(inv.place_of_supply, '07');
  assert.equal(Number(inv.cgst_paise) + Number(inv.sgst_paise), 0, 'CGST or SGST on an inter-state sale');
  const kurta = inv.lines.find((l) => l.grossPaise === 105000);
  assert.equal(kurta.discountPaise, 10500);
  assert.equal(kurta.taxablePaise, 90000);
  assert.equal(kurta.igstPaise, 4500);
  const delivery = inv.lines.find((l) => l.kind === 'charge');
  assert.equal(delivery.grossPaise, 4900);
  for (const l of inv.lines) assert.equal(l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise, l.grossPaise - l.discountPaise);
  assert.equal(Number(inv.taxable_paise) + Number(inv.igst_paise), Number(inv.total_paise));
  assert.equal(Number(inv.total_paise), Number(order.total_paise));
});

test('without a GSTIN the document is a bill of supply in its own series, with no tax', async (t) => {
  const { shop } = await openWorld(t);
  const order = await shop.placeOrder({ lines: [{ product: await shop.product({ pricePaise: 105000, gstRateBp: 500 }) }] });
  await shop.pay(order);
  const [bos] = await shop.invoices(order.id);
  assert.equal(bos.doc_type, 'bill_of_supply');
  assert.match(bos.number, new RegExp(`^BS/${fyLabel}/00001$`));
  assert.equal(Number(bos.cgst_paise) + Number(bos.sgst_paise) + Number(bos.igst_paise), 0);
  assert.equal(Number(bos.taxable_paise), 105000);
});

test('S-43: orders paid at the same moment get consecutive numbers, a rolled-back invoice leaves no gap, and each business counts its own', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.invoiceSettings({ gstin: '27ABCDE1234F1Z5', invoicePrefix: 'TST' });
  const product = await shop.product({ pricePaise: 49900, stock: 50 });
  const orders = [];
  for (let i = 0; i < 8; i++) orders.push(await shop.placeOrder({ lines: [{ product }] }));
  await Promise.all(orders.map((o) => shop.pay(o)));
  // A ninth issued inside a transaction that then fails: its number goes back.
  const ninth = await shop.placeOrder({ lines: [{ product }] });
  await assert.rejects(() => shop.tx(async (tx) => {
    await tx.query(`INSERT INTO invoices (tenant_id, order_id, doc_type, fy, seq, number, seller, buyer, place_of_supply, lines, taxable_paise, total_paise)
      VALUES ($1, $2, 'invoice', 0, 0, '', '{}', '{}', '27', '[{"description":"x"}]', 100, 100)`, [shop.tenant.id, ninth.id]);
    throw new Error('rolled back');
  }), /rolled back/);
  const tenth = await shop.placeOrder({ lines: [{ product }] });
  await shop.pay(tenth);
  await Promise.all(orders.map((o) => shop.inTenant(() => invoicesFor(world.ctx).issueFor(o.id))));
  const all = (await shop.invoices()).filter((i) => i.doc_type === 'invoice');
  assert.equal(all.length, 9);
  const seqs = all.map((i) => i.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9], `The numbers have a gap or a repeat: ${seqs}`);
  assert.equal(new Set(all.map((i) => i.order_id)).size, 9, 'One order got two invoices');
  assert.ok(all.every((i) => /^TST\/\d{2}-\d{2}\/\d{5}$/.test(i.number) && i.number.length <= 16));

  // Writing a second invoice for an order by hand is refused by the database, before a number is used up.
  await assert.rejects(() => shop.tx((tx) => tx.query(`INSERT INTO invoices (tenant_id, order_id, doc_type, fy, seq, number, seller, buyer, place_of_supply, lines, taxable_paise, total_paise)
    VALUES ($1, $2, 'invoice', 0, 0, '', '{}', '{}', '27', '[{"description":"x"}]', 100, 100)`, [shop.tenant.id, tenth.id])), (err) => err.constraint === 'invoices_order_idx');

  const other = await world.secondBusiness();
  await other.invoiceSettings({ gstin: '27ABCDE1234F1Z5', invoicePrefix: 'TST' });
  const theirs = await other.placeOrder({ lines: [{ product: await other.product({ pricePaise: 10000 }) }] });
  await other.pay(theirs);
  const [first] = await other.invoices(theirs.id);
  assert.equal(first.seq, 1, 'Two businesses share one series');
  assert.equal(first.number, `TST/${fyLabel}/00001`, 'The same prefix in another business is its own series');
});

test('S-44: the first invoice after 1 April India time starts the new year’s series at 1', async (t) => {
  const { shop } = await openWorld(t);
  await shop.invoiceSettings({ gstin: '27ABCDE1234F1Z5', invoicePrefix: 'INV' });
  const product = await shop.product({ pricePaise: 49900, stock: 20 });
  const fy = financialYear(new Date());
  const old = [];
  for (const at of [`${fy}-03-31T18:00:00Z`, `${fy}-03-31T18:29:59Z`]) {
    const order = await shop.placeOrder({ lines: [{ product }] });
    const [inv] = await shop.tx((tx) => tx.query(
      `INSERT INTO invoices (tenant_id, order_id, doc_type, fy, seq, number, issued_at, seller, buyer, place_of_supply, lines, taxable_paise, total_paise)
       VALUES ($1, $2, 'invoice', 1999, 77, 'MINE', $3, '{}', '{}', '27', '[{"description":"x"}]', 49900, 49900) RETURNING fy, seq, number`,
      [shop.tenant.id, order.id, at],
    ));
    old.push(inv);
  }
  assert.deepEqual(old.map((i) => [i.fy, i.seq]), [[fy - 1, 1], [fy - 1, 2]], 'The caller chose the number, or 31 March fell into the new year');
  assert.deepEqual(old.map((i) => i.number), [`INV/${financialYearLabel(fy - 1)}/00001`, `INV/${financialYearLabel(fy - 1)}/00002`]);
  const order = await shop.placeOrder({ lines: [{ product }] });
  await shop.pay(order);
  const [inv] = await shop.invoices(order.id);
  assert.equal(inv.fy, fy);
  assert.equal(inv.seq, 1);
  assert.equal(inv.number, `INV/${financialYearLabel(fy)}/00001`);
});

test('an issued invoice cannot be changed or deleted: only its file and a masked buyer may be written', async (t) => {
  const { shop } = await openWorld(t);
  const order = await shop.placeOrder({ lines: [{ product: await shop.product() }] });
  await shop.pay(order);
  const [inv] = await shop.invoices(order.id);
  const refusal = async (sql) => {
    try {
      await shop.tx((tx) => tx.query(sql, [shop.tenant.id, inv.id]));
      return 'changed';
    } catch (err) {
      return err.constraint || err.code;
    }
  };
  assert.equal(await refusal('UPDATE invoices SET total_paise = total_paise + 1, taxable_paise = taxable_paise + 1 WHERE tenant_id = $1 AND id = $2'), 'invoices_frozen');
  assert.equal(await refusal(`UPDATE invoices SET number = 'X/1' WHERE tenant_id = $1 AND id = $2`), 'invoices_frozen');
  assert.equal(await refusal(`UPDATE invoices SET lines = '[{"description":"y"}]' WHERE tenant_id = $1 AND id = $2`), 'invoices_frozen');
  assert.equal(await refusal('DELETE FROM invoices WHERE tenant_id = $1 AND id = $2'), '42501', 'The app login may delete an invoice');
  assert.equal(await refusal(`UPDATE invoices SET buyer = '{"name":""}', buyer_masked_at = now() WHERE tenant_id = $1 AND id = $2`), 'changed');
  const [after] = await shop.invoices(order.id);
  assert.equal(after.number, inv.number);
  assert.equal(Number(after.total_paise), Number(inv.total_paise));
});

test('cash on delivery is invoiced on delivery, refunds get credit notes that add up to what was refunded, and never twice', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.invoiceSettings({ gstin: '27ABCDE1234F1Z5' });
  const product = await shop.product({ pricePaise: 99900, gstRateBp: 1200 });
  const order = await shop.placeOrder({ lines: [{ product, qty: 2 }], mode: 'cod' });
  await shop.pay(order);
  assert.equal((await shop.invoices(order.id)).length, 0, 'A COD order was invoiced before delivery');
  const delivered = await shop.deliver(order);
  assert.equal(delivered.payment_status, 'paid', 'The cash was not recorded as collected');
  const [inv] = await docs(shop, order.id);
  assert.ok(inv, 'No invoice on delivery');
  assert.equal(Number(inv.total_paise), 199800);

  await shop.refundByHand(order, 20000);
  await world.settle();
  await shop.refundByHand(order, 179800);
  await world.settle();
  const notes = (await shop.invoices(order.id)).filter((i) => i.doc_type === 'credit_note');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => Number(n.total_paise)), [20000, 179800]);
  assert.ok(notes.every((n) => Number(n.original_invoice_id) === Number(inv.id) && /^CN\//.test(n.number)));
  assert.deepEqual(notes.map((n) => n.seq), [1, 2]);
  // Credited in full: the notes give back exactly the invoice's tax.
  const sum = (key) => notes.reduce((s, n) => s + Number(n[key]), 0);
  assert.equal(sum('cgst_paise'), Number(inv.cgst_paise));
  assert.equal(sum('sgst_paise'), Number(inv.sgst_paise));
  assert.equal(sum('taxable_paise'), Number(inv.taxable_paise));
  // Hearing the refund again changes nothing.
  const refunds = await shop.sql('SELECT id FROM refunds WHERE tenant_id = $1 AND order_id = $2', [shop.tenant.id, order.id]);
  for (const r of refunds) await shop.inTenant(() => invoicesFor(world.ctx).creditNoteFor(r.id));
  assert.equal((await shop.invoices(order.id)).length, 3);
  const events = await shop.sql(`SELECT count(*)::int AS n FROM order_events WHERE tenant_id = $1 AND order_id = $2 AND type = 'credit_note.issued'`, [shop.tenant.id, order.id]);
  assert.equal(events[0].n, 2);
});

test('a part-advance order is invoiced when the advance is paid, and shows both parts', async (t) => {
  const { shop } = await openWorld(t);
  const order = await shop.placeOrder({ lines: [{ product: await shop.product({ pricePaise: 99900 }) }], mode: 'part_advance', advancePaise: 20000 });
  await shop.pay(order);
  const [inv] = await shop.invoices(order.id);
  assert.ok(inv, 'No invoice when the advance was paid');
  assert.deepEqual([Number(inv.advance_paise), Number(inv.balance_paise), Number(inv.total_paise)], [20000, 79900, 99900]);
});

test('the PDF is drawn by the queue into storage, and the shopper opens it by the order’s link in the seller’s brand only', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.repos.settings.update({ store_name: 'Lamp House' });
  await shop.invoiceSettings({ legalName: 'Lamp House Traders', gstin: '27ABCDE1234F1Z5', address: '4 Mill Lane, Pune' });
  const order = await shop.placeOrder({ lines: [{ product: await shop.product({ pricePaise: 105000 }) }] });
  await shop.pay(order);
  const [inv] = await shop.invoices(order.id);
  assert.equal(inv.file_key, '', 'The file was drawn inside the event, not by the queue');
  const jobs = await shop.sql('SELECT * FROM jobs WHERE queue = $1 AND tenant_id = $2', [PDF_QUEUE, shop.tenant.id]);
  assert.equal(jobs.length, 1, 'No PDF job was queued');

  // Before the job runs the shopper still gets the document, drawn from the row.
  const early = await shop.page(`/order/${order.public_token}/invoice/${encodeURIComponent(inv.number)}`);
  assert.equal(early.status, 200);
  assert.equal(early.headers['content-type'], 'application/pdf');

  assert.equal(await world.runJobs(PDF_QUEUE, pdfJob(world.ctx)), 1);
  const [stored] = await shop.invoices(order.id);
  assert.match(stored.file_key, new RegExp(`^t/${shop.tenant.id}/invoices/${inv.id}-[0-9a-f]{12}\\.pdf$`));
  const bytes = await world.ctx.platform.storage.get(stored.file_key);
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(await world.runJobs(PDF_QUEUE, pdfJob(world.ctx)), 0, 'The job ran twice');

  const res = await shop.page(`/order/${order.public_token}/invoice/${encodeURIComponent(inv.number)}`);
  assert.equal(res.status, 200);
  assert.ok(res.buffer.equals(bytes), 'The shopper was not given the stored file');
  assert.match(res.headers['content-disposition'], /^inline; filename="INV-\d{2}-\d{2}-00001\.pdf"$/);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.doesNotMatch(res.buffer.toString('latin1'), PLATFORM_NAME, 'The PDF names the platform');
  assert.doesNotMatch(JSON.stringify(res.headers), PLATFORM_NAME);
  assert.match(res.buffer.toString('latin1'), /Lamp House/, 'The PDF does not carry the seller’s name');

  // Another order's link, a made-up link, and another business's address get nothing.
  const otherOrder = await shop.placeOrder({ lines: [{ product: await shop.product() }] });
  assert.equal((await shop.page(`/order/${otherOrder.public_token}/invoice/${encodeURIComponent(inv.number)}`)).status, 404);
  assert.equal((await shop.page(`/order/${'x'.repeat(22)}/invoice/${encodeURIComponent(inv.number)}`)).status, 404);
  assert.equal((await shop.page(`/order/${order.public_token}/invoice/${encodeURIComponent('INV/../../etc')}`)).status, 404);
  const other = await world.secondBusiness();
  assert.equal((await other.page(`/order/${order.public_token}/invoice/${encodeURIComponent(inv.number)}`)).status, 404);
});

test('the seller downloads invoices with order access only, and never another business’s', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const order = await shop.placeOrder({ lines: [{ product: await shop.product() }] });
  await shop.pay(order);
  const [inv] = await shop.invoices(order.id);
  const get = (token, host = shop.host) => raw(world.port, `/invoices/${inv.id}/file`, { host, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const owner = await get(shop.token);
  assert.equal(owner.status, 200);
  assert.equal(owner.headers['content-type'], 'application/pdf');
  assert.match(owner.headers['content-disposition'], /^attachment;/);
  assert.equal((await get(null)).status, 401);
  const catalogStaff = await shop.member('staff', { permissions: ['catalog'] });
  assert.equal((await get(catalogStaff.token)).status, 403);
  const orderStaff = await shop.member('staff', { permissions: ['orders'] });
  assert.equal((await get(orderStaff.token)).status, 200);
  assert.equal((await shop.api('GET', `/invoices/${inv.id}`, undefined, { as: catalogStaff.token })).status, 403);
  const other = await world.secondBusiness();
  assert.equal((await get(other.token, other.host)).status, 404);
  assert.equal((await other.api('GET', `/invoices/${inv.id}`)).status, 404);
  assert.deepEqual((await other.api('GET', '/invoices')).json.items, []);
});

test('invoice settings: owner only, a GSTIN must be real and agree with the state, and the prefix fits GST’s 16 characters', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  const before = await shop.api('GET', '/invoice-settings');
  assert.deepEqual(before.json, { legalName: '', gstin: '', stateCode: '', address: '', invoicePrefix: 'INV' });
  assert.equal((await shop.invoiceSettings({ gstin: '27ABCDE1234F1Z5', stateCode: '07' })).status, 400, 'A Maharashtra GSTIN in Delhi');
  assert.equal((await shop.invoiceSettings({ gstin: 'NOTAGSTIN' })).status, 400);
  assert.equal((await shop.invoiceSettings({ gstin: '99ABCDE1234F1Z5' })).status, 400, 'A GSTIN of no state');
  assert.equal((await shop.invoiceSettings({ invoicePrefix: 'TOOLONG' })).status, 400);
  assert.equal((await shop.invoiceSettings({ invoicePrefix: 'ab' })).status, 400);
  assert.equal((await shop.invoiceSettings({ legalName: 'x'.repeat(201) })).status, 400);
  const saved = await shop.invoiceSettings({ legalName: 'Lamp House Traders', gstin: '29ABCDE1234F1Z5', invoicePrefix: 'LH26' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { legalName: 'Lamp House Traders', gstin: '29ABCDE1234F1Z5', stateCode: '29', address: '', invoicePrefix: 'LH26' });
  const manager = await shop.member('manager');
  assert.equal((await shop.api('GET', '/invoice-settings', undefined, { as: manager.token })).status, 200);
  assert.equal((await shop.api('PATCH', '/invoice-settings', { invoicePrefix: 'MGR' }, { as: manager.token })).status, 403);
  assert.ok((await shop.sql(`SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'invoice_settings.update'`, [shop.tenant.id])).length >= 1);
  const other = await world.secondBusiness();
  assert.equal((await other.api('GET', '/invoice-settings')).json.gstin, '', 'Another business sees these settings');
});
