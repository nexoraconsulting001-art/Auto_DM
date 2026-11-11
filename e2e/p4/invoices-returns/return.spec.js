// A real browser on a phone: a shopper asks for a return of a delivered order. Submit is blocked in the page until a photo
// or video is added (S-80), the photo goes up with the form, the store keeps it privately, and the page wears the seller's
// brand only. The shopper's invoice opens from the order's link as a PDF.
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { createWorld } from '../../../test/p4/invoices-returns/support.js';

// The app runs inside Playwright's worker, whose module loader fails on sharp's first import() (a circular require inside one
// of its dependencies). Loading it once with plain require first puts it in the cache the app's import() then reads; a launch
// option of its own gives this file a worker of its own, so nothing else has tried first. The dead proxy stays.
createRequire(import.meta.url)('sharp');
test.use({ launchOptions: { args: ['--proxy-server=http://127.0.0.1:9', '--disable-features=ReturnsOwnWorker'] } });

/** A 16 x 12 PNG, the photo of the item. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAIAAADkharWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGElEQVQokWNYlWZMEmIY1ZA2GkqrsIUBAKFW8kFS+AYiAAAAAElFTkSuQmCC';

test('S-80: a shopper asks for a return on the phone: no proof is refused in the page, a photo goes through', async ({ page, context }) => {
  const w = await createWorld();
  try {
    const { shop } = w;
    await shop.repos.settings.update({ store_name: 'Lamp House' });
    await shop.returnsOn({ windowDays: 7, proof: 'either' });
    const product = await shop.product({ name: 'Brass lamp', pricePaise: 99900, stock: 5 });
    const shopper = await shop.shopper();
    const order = await shop.placeOrder({ lines: [{ product, qty: 2 }], mode: 'cod', shopperId: shopper.id });
    await shop.pay(order);
    await shop.deliver(order);
    await context.addCookies([{ name: '_sid', value: shopper.cookie.slice('_sid='.length), url: w.base }]);

    await page.goto(`${w.base}/account/orders/${order.order_number}/return`);
    await expect(page.locator('h1')).toHaveText('Return an item');
    expect(await page.content()).not.toMatch(/bhava/i);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expect(page.locator('[data-line] input[type=checkbox]')).toBeChecked();
    await page.locator('[data-line] select').selectOption('1');
    await page.fill('textarea[name=reason]', 'The shade is cracked');

    await page.click('#return-form button[type=submit]');
    await expect(page.locator('#return-error')).toHaveText('Add a photo or video of the item');
    expect(await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenant.id])).toHaveLength(0);

    await page.setInputFiles('input[type=file]', { name: 'lamp.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
    await page.click('#return-form button[type=submit]');
    await expect(page.locator('#return-done')).toBeVisible();
    await expect(page.locator('#return-form')).toBeHidden();

    const [ret] = await shop.sql('SELECT * FROM returns WHERE tenant_id = $1', [shop.tenant.id]);
    expect(ret.status).toBe('requested');
    expect(ret.reason).toBe('The shade is cracked');
    const items = await shop.sql('SELECT qty FROM return_items WHERE tenant_id = $1 AND return_id = $2', [shop.tenant.id, ret.id]);
    expect(items.map((i) => i.qty)).toEqual([1]);
    const [proof] = await shop.sql('SELECT * FROM return_proofs WHERE tenant_id = $1', [shop.tenant.id]);
    expect(proof.kind).toBe('photo');
    expect(proof.file_key.startsWith(`t/${shop.tenant.id}/returns/`)).toBe(true);

    // The order's document opens from its link as a PDF.
    const [invoice] = await shop.invoices(order.id);
    const res = await page.request.get(`${w.base}/order/${order.public_token}/invoice/${encodeURIComponent(invoice.number)}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect((await res.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  } finally {
    await w.close();
  }
});
