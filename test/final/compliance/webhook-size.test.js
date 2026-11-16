// compliance-2: PRD 4.3 row 14 takes Meta batches of up to 1,000 entries. Real comment entries run to a few hundred bytes each, so a
// full batch is well over the app's general 200 kB body limit; a 413 would make Meta resend it until it gave up, losing every event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { STORE_PROVIDER_PATHS } from '../../../src/contracts/store-routes.js';
import { IG_ACCOUNT, startApp } from '../../helpers.js';
import { scriptedIg } from '../../p1/compliance/support.js';

const sign = (raw, secret = 'secret') => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const post = (app, path, raw, headers = {}) => fetch(`${app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });

/** A comment as Meta sends it: ids, the commenter, the media and a full sentence of text. */
const entry = (i) => ({
  id: IG_ACCOUNT.igUserId,
  time: 1_762_000_000 + i,
  changes: [{
    field: 'comments',
    value: {
      id: `179${String(i).padStart(14, '0')}`,
      text: `Price please for the blue saree in the second picture, and do you ship to Pune? Comment number ${i} from a real shopper`,
      from: { id: `178414${String(i).padStart(11, '0')}`, username: `shopper_handle_${i}`, self_ig_scoped_id: `IGSID${String(i).padStart(12, '0')}` },
      media: { id: '18475694065114168', media_product_type: 'REELS', original_media_id: '18475694065114168' },
      parent_id: '',
    },
  }],
});

test('compliance-2: a signed batch of 1,000 full-size comments, over 200 kB, is stored and answered 200', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const raw = JSON.stringify({ object: 'instagram', entry: Array.from({ length: 1000 }, (_, i) => entry(i)) });
    assert.ok(Buffer.byteLength(raw) > 200 * 1024, `the batch is ${Buffer.byteLength(raw)} bytes`);
    const res = await post(app, '/webhook', raw, { 'x-hub-signature-256': sign(raw) });
    assert.equal(res.status, 200);
    assert.equal((await app.db.platform.query('SELECT count(*)::int AS n FROM inbound_events'))[0].n, 1000);
  } finally {
    app.close();
    await app.db.close();
  }
});

test('compliance-2: the WhatsApp webhook takes a large delivery to its handlers too, rather than refusing it for size', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const messages = Array.from({ length: 1000 }, (_, i) => ({ from: `9198${String(i).padStart(8, '0')}`, id: `wamid.${'x'.repeat(40)}${i}`, timestamp: '1762000000', type: 'text', text: { body: 'Is the blue saree in the second picture still available in medium size, and can you ship it to Pune by Friday please?' } }));
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '5550001' }, messages } }] }] });
    assert.ok(Buffer.byteLength(raw) > 200 * 1024);
    const res = await post(app, STORE_PROVIDER_PATHS.whatsapp.path, raw);
    assert.notEqual(res.status, 413, 'a large delivery reaches the signature check');
    // A body that size to any other route still meets the general 200 kB limit.
    const other = await post(app, '/api/v1/auth/login', JSON.stringify({ phone: 'x'.repeat(300 * 1024) }));
    assert.equal(other.status, 413);
  } finally {
    app.close();
    await app.db.close();
  }
});

// Same cause, every provider: the provider decides how big its delivery is (a Shopify products/update for a product with many
// variants and images runs past 200 kB), and a 413 makes it retry and then drop the delivery or the subscription. Every POST
// webhook in the contract therefore reaches its signature check whatever its size, up to the webhook limit.
test('compliance-2: every provider webhook in the contract takes a delivery over 200 kB to its signature check', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const raw = JSON.stringify({ id: 1, variants: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: `Size ${i} / Colour ${i}`, sku: `SKU-${'x'.repeat(60)}-${i}` })) });
    assert.ok(Buffer.byteLength(raw) > 200 * 1024);
    const posts = Object.values(STORE_PROVIDER_PATHS).filter((p) => p.method === 'POST');
    assert.ok(posts.length >= 5, 'the contract lists the provider webhooks');
    for (const { path } of posts) {
      const res = await post(app, path.replace(/:[a-z]+/gi, 'unknown-key'), raw);
      assert.notEqual(res.status, 413, `${path} refused a large delivery for its size`);
    }
  } finally {
    app.close();
    await app.db.close();
  }
});
