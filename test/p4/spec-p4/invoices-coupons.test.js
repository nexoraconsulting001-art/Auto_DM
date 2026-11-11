// PRD 9.13 (GST invoices) and 9.14 (coupons). S-42 to S-47. Prices include GST; money is whole paise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, addP4Shop, assertSellerBrandOnly, buyer, financialYear, financialYearLabel, need, newPhone, noCrash, ok, refused, splitGst, sum, taxInside, together, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const delhi = (fields = {}) => address({ city: 'New Delhi', stateCode: '07', pincode: '110001', ...fields });
const fyLabel = financialYearLabel(financialYear(new Date()));

async function invoiced(shop, order, ms = 9000) {
  await world.until(async () => (await shop.invoices(order.id)).some((i) => i.doc_type !== 'credit_note'), ms);
  return (await shop.invoices(order.id)).find((i) => i.doc_type !== 'credit_note');
}

/** The quote. Whether shipping is taxed is still to confirm (9.13), so whole-invoice sums are checked only when there is none. */
async function nothingAdded(b, lines, addr) {
  return ok(await b.quote({ lines, address: addr }), 'A quote').data;
}
const lineOf = (inv, gross) => inv.lines.find((l) => l.grossPaise === gross);

test('S-42: Delhi to Delhi at 5%, Rs 1,050 inclusive: taxable Rs 1,000, CGST Rs 25, SGST Rs 25', async () => {
  const shop = await addP4Shop(world, { stateCode: '07' });
  await shop.invoiceReady({ gstin: '07ABCDE1234F1Z5', prefix: 'LC' });
  const product = await shop.item({ name: 'Cotton kurta', pricePaise: 105000, gstRateBp: 500, hsn: '6109' });
  const b = buyer(world, shop);
  const quote = await nothingAdded(b, [line(product)], delhi());
  if (quote.shippingPaise === 0) assert.equal(quote.taxPaise, 5000);
  const row = await b.buy({ lines: [line(product)], address: delhi() });
  if (Number(row.shipping_paise) === 0) assert.equal(Number(row.tax_paise), 5000);
  const [item] = await shop.orderItems(row.id);
  assert.equal(item.gst_rate_bp, 500);
  assert.equal(item.hsn_code, '6109');
  const inv = await invoiced(shop, row);
  assert.ok(inv, 'No invoice was issued on payment');
  assert.equal(inv.doc_type, 'invoice');
  const kurta = lineOf(inv, 105000);
  assert.ok(kurta, 'The invoice has no line for the kurta');
  assert.equal(kurta.taxablePaise, 100000);
  assert.equal(kurta.cgstPaise, 2500);
  assert.equal(kurta.sgstPaise, 2500);
  assert.equal(kurta.igstPaise, 0);
  if (Number(row.shipping_paise) === 0) {
    assert.equal(Number(inv.taxable_paise), 100000);
    assert.equal(Number(inv.cgst_paise), 2500);
    assert.equal(Number(inv.sgst_paise), 2500);
    assert.equal(Number(inv.total_paise), 105000);
  }
  assert.equal(Number(inv.igst_paise), 0);
  assert.equal(inv.place_of_supply, '07');
  assert.match(inv.number, new RegExp(`^LC/${fyLabel}/\\d{5}$`));
  assert.equal(kurta.hsn, '6109');
  assert.equal(kurta.rateBp, 500);
  const api = need(await shop.send('GET', `/invoices?orderId=${row.id}`), 200, 'The order’s invoices').json().items;
  assert.equal(api.length, 1);
  assert.equal(api[0].cgstPaise, 2500);
  const file = need(await b.open(`/order/${row.placed.token}/invoice/${encodeURIComponent(inv.number)}`), 200, 'The shopper’s invoice');
  assertSellerBrandOnly(file, 'The invoice file');
  const other = await buyer(world, shop).order({ lines: [line(product)], address: delhi() });
  need(await b.open(`/order/${other.token}/invoice/${encodeURIComponent(inv.number)}`), 404, 'This invoice under another order’s link');
});

test('S-42: another state is IGST, odd amounts round to the paisa, and the parts always add up', async () => {
  const shop = await addP4Shop(world, { stateCode: '07' });
  await shop.invoiceReady({ gstin: '07ABCDE1234F1Z5' });
  const kurta = await shop.item({ pricePaise: 105000, gstRateBp: 500, hsn: '6109' });
  const odd = await shop.item({ pricePaise: 99900, gstRateBp: 1800, hsn: '8517' });
  const mug = await shop.item({ pricePaise: 33300, gstRateBp: 1200, hsn: '6912' });
  const mumbai = address({ stateCode: '27', pincode: '400001', city: 'Mumbai' });
  const b = buyer(world, shop);
  await nothingAdded(b, [line(kurta)], mumbai);
  const inter = await invoiced(shop, await b.buy({ lines: [line(kurta)], address: mumbai }));
  assert.equal(lineOf(inter, 105000).igstPaise, 5000);
  assert.equal(Number(inter.cgst_paise) + Number(inter.sgst_paise), 0, 'CGST and SGST on an inter-state sale');
  assert.equal(inter.place_of_supply, '27');
  const row = await buyer(world, shop).buy({ lines: [line(odd), line(mug, 3)], address: delhi() });
  const inv = await invoiced(shop, row);
  const expected = [[99900, 1800], [99900, 1200]].map(([gross, rate]) => {
    const { taxablePaise, taxPaise } = taxInside(gross, rate);
    return { taxablePaise, ...splitGst(taxPaise, { sellerState: '07', buyerState: '07' }) };
  });
  for (const [i, gross] of [[0, 99900], [1, 99900]]) {
    const l = inv.lines.filter((x) => x.grossPaise === gross)[i];
    assert.ok(l, `No invoice line of ${gross}`);
  }
  const odds = inv.lines.filter((x) => x.grossPaise === 99900).sort((x, y) => y.rateBp - x.rateBp);
  for (let i = 0; i < 2; i++) {
    assert.equal(odds[i].taxablePaise, expected[i].taxablePaise, `Line at ${odds[i].rateBp} bp: taxable`);
    assert.equal(odds[i].cgstPaise, expected[i].cgstPaise);
    assert.equal(odds[i].sgstPaise, expected[i].sgstPaise);
  }
  assert.equal(Number(inv.taxable_paise) + Number(inv.cgst_paise) + Number(inv.sgst_paise) + Number(inv.igst_paise), Number(inv.total_paise));
  for (const l of inv.lines) {
    assert.ok([l.taxablePaise, l.cgstPaise, l.sgstPaise, l.igstPaise].every(Number.isInteger), 'An invoice line holds a fraction of a paisa');
    assert.equal(l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise, l.grossPaise - (l.discountPaise ?? 0));
  }
});

test('S-42: GST is worked out on the discounted value, and without a GSTIN the document is a bill of supply', async () => {
  const shop = await addP4Shop(world, { stateCode: '07' });
  await shop.invoiceReady({ gstin: '07ABCDE1234F1Z5' });
  await shop.coupon({ code: 'TENOFF', kind: 'percent', percentBp: 1000 });
  const product = await shop.item({ pricePaise: 105000, gstRateBp: 500 });
  const b = buyer(world, shop);
  const row = await b.buy({ lines: [line(product)], address: delhi(), couponCode: 'TENOFF' });
  assert.equal(Number(row.discount_paise), 10500);
  const inv = await invoiced(shop, row);
  const discounted = lineOf(inv, 105000);
  assert.equal(discounted.taxablePaise, 90000, 'GST was not worked out on the discounted value');
  assert.equal(discounted.cgstPaise + discounted.sgstPaise, 4500);
  const plain = await addP4Shop(world, { stateCode: '07' });
  await plain.invoiceReady({ gstin: '' });
  const item = await plain.item({ pricePaise: 105000, gstRateBp: 500 });
  const bos = await invoiced(plain, await buyer(world, plain).buy({ lines: [line(item)], address: delhi() }));
  assert.equal(bos.doc_type, 'bill_of_supply');
  assert.equal(Number(bos.cgst_paise) + Number(bos.sgst_paise) + Number(bos.igst_paise), 0);
  assert.match(bos.number, /^BS\//);
});

test('S-43: invoices of orders paid in the same moment get consecutive numbers with no gap', async () => {
  const shop = await addP4Shop(world);
  await shop.invoiceReady();
  const product = await shop.item({ pricePaise: 49900, stock: 20 });
  const orders = [];
  for (let i = 0; i < 6; i++) orders.push(await buyer(world, shop).order({ lines: [line(product)] }));
  await together(orders.length, (i) => world.rzp.post('/pay', { orderId: orders[i].gateway.gatewayOrderId, webhook: true }));
  await world.until(async () => (await shop.invoices()).length >= orders.length, 15_000);
  const all = (await shop.invoices()).filter((i) => i.doc_type === 'invoice');
  assert.equal(all.length, orders.length, `${all.length} invoices for ${orders.length} paid orders`);
  const seqs = all.map((i) => i.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, seqs.map((_, i) => seqs[0] + i), `The numbers have a gap: ${seqs}`);
  assert.equal(seqs[0], 1, 'The first invoice of the year is not number 1');
  assert.equal(new Set(all.map((i) => i.number)).size, all.length);
  assert.equal(new Set(all.map((i) => i.order_id)).size, all.length, 'One order got two invoices');
  // A repeated payment event never issues a second invoice.
  const [first] = orders;
  const delivery = (await world.rzp.get('/webhooks')).deliveries.find((d) => d.body?.payload?.payment?.entity?.order_id === first.gateway.gatewayOrderId);
  await world.rzp.post('/webhooks/redeliver', { id: delivery.id, times: 2 });
  await world.quiet(1500);
  assert.equal((await shop.invoices()).filter((i) => i.doc_type === 'invoice').length, orders.length);
  // Another business’s numbers are its own.
  const other = await addP4Shop(world);
  await other.invoiceReady();
  const theirs = await invoiced(other, await buyer(world, other).buy({ lines: [line(await other.item({ pricePaise: 10000 }))] }));
  assert.equal(theirs.seq, 1, 'Two businesses share one invoice series');
});

test('S-44: the first invoice after 1 April starts the new financial year’s series at 1', async () => {
  const shop = await addP4Shop(world);
  await shop.invoiceReady({ prefix: 'INV' });
  const product = await shop.item({ pricePaise: 49900, stock: 20 });
  // Two documents issued last financial year, right up to midnight India time on 31 March.
  const fy = financialYear(new Date());
  const old = [];
  for (const at of [`${fy}-03-31T18:29:59Z`, `${fy}-03-31T18:00:00Z`]) {
    const order = await shop.order((await buyer(world, shop).order({ lines: [line(product)] })).orderNumber);
    const [inv] = await shop.sql(
      `INSERT INTO invoices (tenant_id, order_id, doc_type, fy, seq, number, issued_at, seller, buyer, place_of_supply, lines, taxable_paise, total_paise)
       VALUES ($1, $2, 'invoice', 0, 0, '', $3, '{}', '{}', '27', '[{"description":"x"}]', 49900, 49900) RETURNING fy, seq, number`,
      [shop.tenantId, order.id, at],
    );
    old.push(inv);
  }
  assert.deepEqual(old.map((i) => i.fy), [fy - 1, fy - 1], 'An invoice on 31 March fell into the new year');
  const [{ fy: boundary }] = await shop.sql(`SELECT financial_year('${fy}-03-31T18:30:00Z') AS fy`);
  assert.equal(boundary, fy, 'Midnight on 1 April India time is not the new year');
  const row = await buyer(world, shop).buy({ lines: [line(product)] });
  const inv = await invoiced(shop, row);
  assert.equal(inv.fy, fy);
  assert.equal(inv.seq, 1, 'The new year’s series did not start at 1');
  assert.equal(inv.number, `INV/${financialYearLabel(fy)}/00001`);
  assert.ok(old.every((o) => o.number.startsWith(`INV/${financialYearLabel(fy - 1)}/`)));
});

// ---- coupons ----

test('S-45: REEL10 (10%, cap Rs 150) on Rs 2,000 takes off Rs 150, whatever case the code is typed in', async () => {
  const shop = await addP4Shop(world);
  const coupon = await shop.coupon({ code: 'reel10', kind: 'percent', percentBp: 1000, maxDiscountPaise: 15000 });
  assert.equal(coupon.code, 'REEL10', 'Codes are not stored in capitals');
  const product = await shop.item({ pricePaise: 200000 });
  const b = buyer(world, shop);
  for (const code of ['REEL10', 'reel10', ' Reel10 ']) {
    const q = ok(await b.quote({ lines: [line(product)], couponCode: code }), `Quoting ${code}`).data;
    assert.equal(q.discountPaise, 15000, `${code}: the discount is ${q.discountPaise}`);
    assert.equal(q.coupon.applied, true);
    assert.equal(q.totalPaise, q.subtotalPaise - 15000 + q.shippingPaise + q.codFeePaise);
  }
  const placed = await b.order({ lines: [line(product)], couponCode: 'reel10' });
  const order = await shop.order(placed.orderNumber);
  assert.equal(Number(order.discount_paise), 15000);
  assert.equal(order.coupon_code, 'REEL10');
  assert.equal(placed.gateway.amountPaise, Number(order.total_paise));
  const small = await shop.item({ pricePaise: 99900 });
  assert.equal(ok(await b.quote({ lines: [line(small)], couponCode: 'REEL10' }), 'Under the cap').data.discountPaise, 9990);
  const tiny = await shop.item({ pricePaise: 999 });
  const t = ok(await b.quote({ lines: [line(tiny)], couponCode: 'REEL10' }), '10% of Rs 9.99').data;
  assert.ok(Number.isInteger(t.discountPaise) && Math.abs(t.discountPaise - 99.9) <= 1, `10% of 999 paise came to ${t.discountPaise}`);
});

test('S-45: a coupon off its dates, inactive, under its minimum, out of scope or another business’s takes nothing off', async () => {
  const shop = await addP4Shop(world);
  const other = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 100000 });
  const elsewhere = await shop.item({ pricePaise: 100000 });
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  await shop.coupon({ code: 'ENDED', kind: 'flat', amountPaise: 5000, startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), endsAt: past });
  await shop.coupon({ code: 'SOON', kind: 'flat', amountPaise: 5000, startsAt: future });
  await shop.coupon({ code: 'OFFNOW', kind: 'flat', amountPaise: 5000, active: false });
  await shop.coupon({ code: 'BIGBUY', kind: 'flat', amountPaise: 5000, minOrderPaise: 500000 });
  await shop.coupon({ code: 'ONLYONE', kind: 'percent', percentBp: 5000, scope: 'products', scopeIds: [elsewhere.id] });
  await other.coupon({ code: 'THEIRS', kind: 'flat', amountPaise: 5000 });
  const b = buyer(world, shop);
  for (const code of ['ENDED', 'SOON', 'OFFNOW', 'BIGBUY', 'ONLYONE', 'THEIRS', 'NOSUCH']) {
    const q = ok(await b.quote({ lines: [line(product)], couponCode: code }), `Quoting ${code}`).data;
    assert.equal(q.discountPaise, 0, `${code} took ${q.discountPaise} off`);
    assert.equal(q.coupon?.applied ?? false, false);
    assert.ok(q.coupon?.message, `${code}: no message saying why`);
    const placed = noCrash(await b.place(b.checkoutBody({ lines: [line(product)], couponCode: code })), `Ordering with ${code}`);
    if (placed.status < 300) assert.equal(Number((await shop.order(placed.data.orderNumber)).discount_paise), 0, `${code} was applied inside the order`);
  }
  const scoped = ok(await b.quote({ lines: [line(product), line(elsewhere)], couponCode: 'ONLYONE' }), 'A scoped coupon on a mixed bag').data;
  assert.equal(scoped.discountPaise, 50000, 'A product coupon discounted products outside its scope');
  refused(await b.quote({ lines: [line(product)], couponCode: 'X'.repeat(41) }), 'A code over 40 characters', 400);
  for (const code of ['REEL10,ENDED', 'REEL10 ENDED']) assert.equal(ok(await b.quote({ lines: [line(product)], couponCode: code }), 'Two codes in one').data.discountPaise, 0);
});

test('S-45: a flat coupon bigger than the bag never takes the total below zero, and a used coupon’s code is fixed', async () => {
  const shop = await addP4Shop(world);
  await shop.codOn();
  const coupon = await shop.coupon({ code: 'HUGE', kind: 'flat', amountPaise: 1_000_000 });
  const product = await shop.item({ pricePaise: 49900 });
  const b = buyer(world, shop);
  const q = ok(await b.quote({ lines: [line(product)], couponCode: 'HUGE' }), 'A flat coupon bigger than the bag').data;
  assert.ok(q.discountPaise <= q.subtotalPaise, 'The discount is more than the bag');
  assert.ok(q.totalPaise >= 0);
  await b.signIn();
  const placed = noCrash(await b.place(b.checkoutBody({ lines: [line(product)], couponCode: 'HUGE', paymentMode: 'cod' })), 'Ordering with it');
  if (placed.status < 300 && placed.data.orderNumber) {
    const order = await shop.order(placed.data.orderNumber);
    assert.ok(Number(order.total_paise) >= 0 && Number(order.discount_paise) <= Number(order.subtotal_paise));
    refused(await shop.send('PATCH', `/coupons/${coupon.id}`, { code: 'RENAMED' }), 'Changing a used coupon’s code', [400, 409, 422]);
    refused(await shop.send('PATCH', `/coupons/${coupon.id}`, { kind: 'percent', percentBp: 100, amountPaise: null }), 'Changing a used coupon’s kind', [400, 409, 422]);
  }
  refused(await shop.send('POST', '/coupons', { code: 'HUGE', kind: 'flat', amountPaise: 100 }), 'A second coupon with the same code', [400, 409]);
  refused(await shop.send('POST', '/coupons', { code: 'huge', kind: 'flat', amountPaise: 100 }), 'The same code in lower case', [400, 409]);
  for (const bad of [{ code: 'A', kind: 'flat', amountPaise: 100 }, { code: 'BAD CODE', kind: 'flat', amountPaise: 100 }, { code: 'NEG', kind: 'flat', amountPaise: -100 }, { code: 'PCT', kind: 'percent', percentBp: 10001 }, { code: 'ZERO', kind: 'percent', percentBp: 0 }]) {
    refused(await shop.send('POST', '/coupons', bad), `Coupon ${JSON.stringify(bad)}`, 400);
  }
});

test('S-46: a per-customer limit of one holds on the second use, as a guest by phone, and at the same moment', async () => {
  const shop = await addP4Shop(world);
  const coupon = await shop.coupon({ code: 'ONCE', kind: 'flat', amountPaise: 5000, maxUsesPerCustomer: 1 });
  const product = await shop.item({ pricePaise: 100000, stock: 50 });
  const b = buyer(world, shop);
  const phone = await b.signIn();
  const first = await b.order({ lines: [line(product)], couponCode: 'ONCE', address: address({ phone }) });
  assert.equal(Number((await shop.order(first.orderNumber)).discount_paise), 5000);
  const q = ok(await b.quote({ lines: [line(product)], couponCode: 'once' }), 'Quoting it again').data;
  assert.equal(q.discountPaise, 0);
  assert.ok(q.coupon.message);
  const second = noCrash(await b.place(b.checkoutBody({ lines: [line(product)], couponCode: 'ONCE', address: address({ phone }) })), 'Using it a second time');
  if (second.status < 300) assert.equal(Number((await shop.order(second.data.orderNumber)).discount_paise), 0, 'The second use got the discount');
  const guest = buyer(world, shop);
  const viaGuest = noCrash(await guest.place(guest.checkoutBody({ lines: [line(product)], couponCode: 'ONCE', address: address({ phone }) })), 'The same phone as a guest');
  if (viaGuest.status < 300) assert.equal(Number((await shop.order(viaGuest.data.orderNumber)).discount_paise), 0, 'A guest with the same phone used it again');
  const racer = buyer(world, shop);
  const racePhone = await racer.signIn();
  const race = await together(4, () => racer.place(racer.checkoutBody({ lines: [line(product)], couponCode: 'ONCE', address: address({ phone: racePhone }) })));
  race.forEach((r) => noCrash(r, 'Racing one customer’s use'));
  const discounted = (await shop.orders('discount_paise > 0'));
  assert.equal(discounted.length, 2, `${discounted.length} discounted orders for two customers with a limit of one each`);
  const [{ n }] = await shop.sql(`SELECT count(*)::int AS n FROM coupon_redemptions WHERE tenant_id = $1 AND coupon_id = $2 AND status = 'applied'`, [shop.tenantId, coupon.id]);
  assert.equal(n, 2);
});

test('S-46: cancelling the order that used the coupon gives the use back', async () => {
  const shop = await addP4Shop(world);
  await shop.coupon({ code: 'ONCEMORE', kind: 'flat', amountPaise: 5000, maxUsesPerCustomer: 1 });
  const product = await shop.item({ pricePaise: 100000, stock: 5 });
  const b = buyer(world, shop);
  await b.signIn();
  const row = await b.buy({ lines: [line(product)], couponCode: 'ONCEMORE' });
  ok(await b.cancelOrder(row.order_number), 'Cancelling it');
  await shop.orderWhen(row.order_number, (o) => o.fulfilment_status === 'cancelled');
  await world.quiet(1500);
  assert.equal(ok(await b.quote({ lines: [line(product)], couponCode: 'ONCEMORE' }), 'Quoting after the cancel').data.discountPaise, 5000, 'A cancelled order still uses up the coupon');
});

test('S-47: a total limit of three holds when eight shoppers check out at once', async () => {
  const shop = await addP4Shop(world);
  const coupon = await shop.coupon({ code: 'FIRST3', kind: 'flat', amountPaise: 10000, maxUses: 3 });
  const product = await shop.item({ pricePaise: 100000, stock: 50 });
  const answers = await together(8, () => {
    const b = buyer(world, shop);
    return b.place(b.checkoutBody({ lines: [line(product)], couponCode: 'FIRST3', address: address({ phone: newPhone() }) }));
  });
  answers.forEach((r) => noCrash(r, 'A simultaneous checkout'));
  const discounted = await shop.orders('discount_paise > 0');
  assert.equal(discounted.length, 3, `${discounted.length} orders got a coupon limited to three`);
  const [row] = await shop.sql('SELECT used_count FROM coupons WHERE tenant_id = $1 AND id = $2', [shop.tenantId, coupon.id]);
  assert.equal(row.used_count, 3);
  const after = ok(await buyer(world, shop).quote({ lines: [line(product)], couponCode: 'FIRST3' }), 'Quoting after the limit').data;
  assert.equal(after.discountPaise, 0);
  const stats = need(await shop.send('GET', `/coupons/${coupon.id}/stats`), 200, 'Coupon stats').json();
  assert.equal(stats.orders, 3);
  assert.equal(stats.discountPaise, 30000);
  const other = await addP4Shop(world);
  need(await other.send('GET', `/coupons/${coupon.id}`), 404, 'Another business reading this coupon');
  need(await other.send('GET', `/coupons/${coupon.id}/stats`), 404, 'Another business reading its stats');
});
