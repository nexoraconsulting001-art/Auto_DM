/**
 * The simulator and the real app together: a signed webhook from the simulator goes through the app's /webhook,
 * and the app's own Instagram client answers back to the simulator, which enforces Meta's rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstagram } from '../../../src/instagram.js';
import { IG_ACCOUNT, REEL_ID, seedReel, startApp } from '../../helpers.js';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { until } from './support.js';

const SECRET = 'secret'; // the app secret startApp configures

async function setup(t) {
  const meta = await createMeta({ app: { secret: SECRET, echoes: true } }).start();
  t.after(() => meta.close());
  await meta.post('/accounts', { igUserId: IG_ACCOUNT.igUserId, username: IG_ACCOUNT.username, token: IG_ACCOUNT.token, subscribedFields: ['comments', 'messages'] });

  const app = await startApp({ ig: createInstagram({ graphBaseUrl: meta.url, graphVersion: 'v23.0' }) });
  t.after(async () => {
    app.close();
    await app.db.close();
  });
  await seedReel(app.repos);
  await meta.post('/app', { webhookUrl: `${app.base}/webhook` });

  const comment = (fields = {}) => meta.post('/comments', { igUserId: IG_ACCOUNT.igUserId, mediaId: REEL_ID, from: { id: 'shopper-1', username: 'asha' }, text: 'LINK please', ...fields });
  const dms = async () => (await meta.get('/sent', { kind: 'private_reply' })).sent;
  return { meta, app, comment, dms };
}

test('a comment on a live reel becomes one button DM through the whole app', async (t) => {
  const { meta, comment, dms } = await setup(t);
  const { comment: { id }, delivery } = await comment();
  assert.deepEqual([delivery.delivered, delivery.status], [true, 200]);

  const [dm] = await until(async () => {
    const list = await dms();
    return list.length ? list : null;
  });
  assert.equal(dm.commentId, id);
  assert.equal(dm.recipientId, 'shopper-1');
  assert.equal(dm.igUserId, IG_ACCOUNT.igUserId);
  assert.equal(dm.message.attachment.payload.template_type, 'button');
  assert.match(dm.message.attachment.payload.buttons[0].url, /^https:\/\/shop\.test\/r\//);

  const [call] = (await meta.calls()).filter((c) => c.path.endsWith('/messages'));
  assert.equal(call.headers.authorization, `Bearer ${IG_ACCOUNT.token}`, 'sent with the account\'s own token');
  assert.equal(call.status, 200);
  assert.equal(call.path, `/v23.0/${IG_ACCOUNT.igUserId}/messages`);
});

test('a delivery with a bad signature is refused by the app and sends nothing', async (t) => {
  const { meta, comment, dms } = await setup(t);
  const { delivery } = await comment({ signature: 'bad' });
  assert.deepEqual([delivery.delivered, delivery.status], [false, 401]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await dms(), []);
  assert.deepEqual(await meta.calls(), []);
});

test('the same comment delivered three times produces one DM', async (t) => {
  const { meta, comment, dms } = await setup(t);
  await comment({ id: 'dup-1', duplicates: 3 });
  await until(async () => (await dms()).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await dms()).length, 1);
  const refused = (await meta.calls()).filter((c) => c.status !== null && c.status !== 200);
  assert.deepEqual(refused, [], 'the app never even tried a second reply');
});

test('the app can be subscribed and handshaken like Meta would', async (t) => {
  const { meta } = await setup(t);
  await meta.post('/app', { verifyToken: 'vt' });
  assert.deepEqual(await meta.post('/webhooks/verify'), { status: 200, verified: true });
  assert.equal((await meta.post('/webhooks/verify', { verifyToken: 'wrong' })).verified, false);
});

test('a comment on a reel the app does not map produces no DM', async (t) => {
  const { comment, dms } = await setup(t);
  await comment({ mediaId: '18999999999999999' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await dms(), []);
});

test('Graph\'s echo of the DM does not make the app send again', async (t) => {
  const { meta, comment, dms } = await setup(t);
  await comment();
  await until(async () => (await dms()).length === 1);
  await until(async () => (await meta.get('/webhooks')).deliveries.some((d) => d.body?.entry?.[0]?.messaging?.[0]?.message?.is_echo));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await dms()).length, 1);
});
