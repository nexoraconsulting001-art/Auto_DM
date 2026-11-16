// D-13: a lost Instagram, Facebook or WhatsApp connection pauses every send of the business, and PRD 4.2 wants the owner
// told at once (push and a Bhava email, and WhatsApp as the token.invalid kind says) "on rejection or deauthorization". The
// alerts those losses raise are token.rejected and token.deauthorized (the compliance token decisions); the notifications
// pipeline must turn them into token.invalid, not leave them in the console's alerts list only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTIFY_SOURCES } from '../../../src/contracts/notifications.js';
import { IG_ACCOUNT } from '../../helpers.js';
import { MINUTE, accepted, connect, emailsTo, startWorld, whatsappsTo } from '../../p5/notifications/support.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let w;
let owner;

before(async () => {
  w = await startWorld();
  owner = await connect(w, { devices: ['android'] });
});
after(() => w?.close());

const reset = async () => {
  w.clock.advance(10 * MINUTE);
  await w.sims.push.post('/reset');
  await w.sims.email.post('/reset');
  await w.sims.whatsapp.post('/reset');
};
const eventFor = async (alertKind, dedupeKey) => (await w.sql(
  `SELECT e.kind, e.data, e.audience FROM notification_events e JOIN alerts a ON e.event_key = 'alert:' || a.id
    WHERE a.tenant_id = $1 AND a.kind = $2 AND a.dedupe_key = $3`,
  [w.tenant.id, alertKind, dedupeKey],
))[0];

test('an Instagram token the platform rejects tells the owner at once by push, email and WhatsApp', async () => {
  await reset();
  // The test business's own linked account (test/helpers.js IG_ACCOUNT), through the repo every token loss goes through.
  assert.equal(await w.inTenant(() => w.app.repos.igAccounts.loseToken(IG_ACCOUNT.igUserId, 'token.rejected', { actor: 'test' })), true);
  await w.worker().drain();
  const [alert] = await w.sql(`SELECT dedupe_key FROM alerts WHERE tenant_id = $1 AND kind = 'token.rejected' AND audience = 'owner'`, [w.tenant.id]);
  const event = await eventFor('token.rejected', alert.dedupe_key);
  assert.ok(event, 'the alert became a notification');
  assert.equal(event.kind, 'token.invalid');
  assert.equal(event.data.account, 'Instagram');
  assert.deepEqual((await accepted(w, owner.devices[0].token)).map((p) => p.data.kind), ['token.invalid'], 'one push');
  assert.equal((await emailsTo(w, owner.email)).length, 1, 'one email');
  assert.equal((await whatsappsTo(w, owner.phone)).length, 1, 'one WhatsApp');
});

test('Meta removing access (deauthorize) is told to the owner the same way, once', async () => {
  await reset();
  await w.inTenant(() => w.app.repos.igAccounts.setToken(IG_ACCOUNT.igUserId, 'reconnected-token')); // reconnected: a new token version
  assert.equal(await w.inTenant(() => w.app.repos.igAccounts.loseToken(IG_ACCOUNT.igUserId, 'token.deauthorized', { actor: 'meta:deauthorize' })), true);
  await w.worker().drain();
  const [alert] = await w.sql(`SELECT dedupe_key FROM alerts WHERE tenant_id = $1 AND kind = 'token.deauthorized' AND audience = 'owner'`, [w.tenant.id]);
  assert.equal((await eventFor('token.deauthorized', alert.dedupe_key))?.kind, 'token.invalid');
  assert.deepEqual((await accepted(w, owner.devices[0].token)).map((p) => p.data.kind), ['token.invalid'], 'one push, not one per audience');
});

test('a rejection raised by the compliance gate for Facebook or WhatsApp names the channel in the notification', async () => {
  await reset();
  // The shape compliance/send.js and facebook/repo.js raise: the account id as the target, the channel in the dedupe key.
  for (const [channel, id] of [['facebook', '1029384756'], ['whatsapp', '5550001']]) {
    await w.inTenant(() => w.app.repos.alerts.raise({ kind: 'token.rejected', severity: 'critical', target: id, message: 'Reconnect it to start sending again.', dedupeKey: `token.rejected:${channel}:${id}:1` }));
  }
  await w.worker().drain();
  assert.equal((await eventFor('token.rejected', 'token.rejected:facebook:1029384756:1'))?.data.account, 'Facebook');
  assert.equal((await eventFor('token.rejected', 'token.rejected:whatsapp:5550001:1'))?.data.account, 'WhatsApp');
});

test('every alert kind the notifications map listens for is one the code actually raises', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const modules = walk(path.join(repoRoot, 'src/modules')).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}notifications${path.sep}`)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const kind of Object.keys(NOTIFY_SOURCES.alerts)) {
    assert.ok(modules.includes(`'${kind}'`), `"${kind}" is mapped to a notification, but no module raises an alert of that kind`);
  }
  assert.equal(NOTIFY_SOURCES.alerts['token.rejected'], 'token.invalid');
  assert.equal(NOTIFY_SOURCES.alerts['token.deauthorized'], 'token.invalid');
});
