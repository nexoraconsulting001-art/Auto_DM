// What the buyer-ui track's tests share: a store set up as a seller would set it up (WhatsApp, payments, pickup, consent
// notice, invoices, returns, cash on delivery), a reel landing page with a product in two sizes, and checks for what a buyer
// can see: no platform name anywhere, direct links only, and the page reading well at phone size.
//
// Built on the Phase 4 spec world (test/p4/spec-p4/kit.js): the app, its worker and every simulator (Razorpay, Shiprocket,
// WhatsApp, mail, Google) on this machine. Nothing here reaches a real service.
import http from 'node:http';
import zlib from 'node:zlib';
import { WHATSAPP_TEMPLATES } from '../../../src/modules/order-alerts/templates.js';
import { addP4Shop, buyer, newPhone, openP4World, png, unique, UA } from '../spec-p4/kit.js';

export { UA, buyer, newPhone, png, unique };

/** The platform's name, in any case, anywhere: a buyer must never see it. */
export const PLATFORM_NAME = /bhava/i;
/** The courier aggregator the store ships through in managed mode: the buyer sees the seller and the courier, never it. */
export const AGGREGATOR_NAME = /shiprocket/i;

export const SHOP_NAME = 'Leafy Corner';
export const PRODUCT_NAME = 'Monstera in clay pot';

/**
 * A world with one store on its default address (so a browser at world.base is on the store), ready to sell: a product in
 * sizes M and L with a photo, a second product, and a reel landing page showing the first. COD and returns are on.
 */
export async function openStore({ name = SHOP_NAME, preset = '' } = {}) {
  const slug = `buyer-ui-${unique()}`.toLowerCase();
  const world = await openP4World({ defaultTenant: slug });
  try {
    const shop = await addP4Shop(world, { slug, name });
    await shop.invoiceReady();
    await shop.codOn();
    await shop.returnsOn();
    await shop.whatsapp('9811100002');
    if (preset) await shop.must('PUT', '/theme', { preset, tuneAccent: true }, 200, `Choosing the ${preset} look`);
    const photo = await shop.upload('#3B7A57');
    const plant = await shop.item({
      name: PRODUCT_NAME,
      pricePaise: 49900,
      mrpPaise: 69900,
      description: 'A young monstera, potted in hand-thrown clay.',
      images: [photo],
      options: [{ name: 'Size', values: ['M', 'L'] }],
      variants: [
        { optionValues: ['M'], pricePaise: 49900, mrpPaise: 69900, inStock: true },
        { optionValues: ['L'], pricePaise: 64900, mrpPaise: 89900, inStock: true },
      ],
    });
    const variants = await shop.sql('SELECT id, option_values FROM product_variants WHERE tenant_id = $1 AND product_id = $2 ORDER BY position', [shop.tenantId, plant.id]);
    const size = Object.fromEntries(variants.filter((v) => v.option_values.length).map((v) => [v.option_values[0], v.id]));
    const pot = await shop.item({ name: 'Terracotta planter', pricePaise: 39900, images: [await shop.upload('#C8794E')] });
    const reel = await shop.page({ productIds: [plant.id, pot.id], caption: 'Balcony glow-up' });
    return { world, shop, plant, pot, size, reel };
  } catch (err) {
    await world.close();
    throw err;
  }
}

/** Where the store's address for a browser is: the default business answers on the world's own base address. */
export const pathOf = (url) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/** The gateway order the payments module made for an order (the payment screen opens on it). */
export async function gatewayOrderOf(shop, orderNumber) {
  const [row] = await shop.sql(
    `SELECT p.gateway_order_id FROM payments p JOIN orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
     WHERE o.tenant_id = $1 AND o.order_number = $2 ORDER BY p.id DESC LIMIT 1`,
    [shop.tenantId, orderNumber],
  );
  return row?.gateway_order_id ?? null;
}

/** Every piece of text a WhatsApp message or an email carries, flattened. */
export const messageText = (m) => JSON.stringify(m?.body ?? m ?? {});

/** A WhatsApp template message as the shopper reads it: the template's body with its values in place. Other messages as sent. */
export function readAs(m) {
  const template = m.body?.template;
  if (!template) return messageText(m);
  const values = (template.components ?? []).filter((c) => c.type === 'body').flatMap((c) => c.parameters ?? []).map((p) => p.text ?? '');
  const body = WHATSAPP_TEMPLATES[template.name]?.body ?? `[unknown template ${template.name}]`;
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? '');
}

/** Links inside a message's text. */
export const linksIn = (text) => [...String(text).matchAll(/https?:\/\/[^\s"'<>\\]+/g)].map((m) => m[0].replace(/[).,]+$/, ''));

/**
 * Text a buyer can see on a rendered page, read in the browser: the visible text, the title, every attribute a browser or a
 * screen reader shows (alt, title, aria-label, placeholder, value of buttons), the head's meta tags and the manifest's link.
 * Runs inside page.evaluate.
 */
export function visibleTextInPage() {
  const parts = [document.title, document.body.innerText];
  for (const el of document.querySelectorAll('[alt], [title], [aria-label], [placeholder], [aria-description], input[type=submit], input[type=button], button')) {
    for (const a of ['alt', 'title', 'aria-label', 'placeholder', 'aria-description', 'value']) if (el.getAttribute(a)) parts.push(el.getAttribute(a));
  }
  for (const meta of document.querySelectorAll('meta[content]')) parts.push(meta.getAttribute('content'));
  return parts.join('\n');
}

/**
 * The words in a PDF as a reader of it would see them, roughly: every content stream inflated, and every string in it
 * (hex or literal) decoded as Latin-1, plus the document's own strings (title, author, producer). Enough to find a name.
 */
export function pdfText(buffer) {
  const raw = Buffer.from(buffer).toString('latin1');
  const chunks = [raw];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      chunks.push(zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // not a compressed stream (an image, or plain text already in `raw`)
    }
  }
  const text = chunks.join('\n');
  const hex = [...text.matchAll(/<([0-9a-fA-F\s]{2,})>/g)].map((m) => Buffer.from(m[1].replace(/\s/g, ''), 'hex').toString('latin1'));
  const literal = [...text.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return [...hex, ...literal].join(' ');
}

/** A GET on the store's own host whose answer is kept as bytes (a PDF, an image), with the shopper's cookies when given. */
export function getBytes(world, host, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(new URL(world.base).port), path, method: 'GET', headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
