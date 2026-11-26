// R2-SEC-1 (PRD 5.15, F-64): a stored secret is sealed to its record. A value copied to another business's row, to
// another row or to another column does not open there; a value written before the binding still reads until
// SECRETS_REQUIRE_BINDING, and the re-wrap job binds it to its row; a value the job finds bound to another record is
// left alone and counted as a failure. Every column of SECRET_COLUMNS reads and writes with its binding.
import '../../../tools/net-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SECRET_COLUMNS, secretBinding } from '../../../src/contracts/secrets.js';
import { createSecretRotation } from '../../../src/modules/secret-rotation/index.js';
import { createSecrets, describeStored } from '../../../src/platform/secrets.js';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { openTestDb } from '../../helpers.js';

const key = () => crypto.randomBytes(32).toString('base64');
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code ?? e.name;
  }
};
const rowFor = (col, tenantId, n = 1) => Object.fromEntries(col.bind.map((name) => [name, name === 'tenant_id' ? tenantId : `${name}-${n}`]));

test('R2-SEC-1: every secret column writes and reads with its binding, and never opens as another business, row or column', () => {
  for (const format of ['v1', 'v2']) {
    const secrets = createSecrets({ dataKey: key(), secretsFormat: format, secretsRequireBinding: true });
    for (const col of SECRET_COLUMNS) {
      const here = secretBinding(col.table, col.column, rowFor(col, 7));
      const stored = secrets.encrypt(`value-of-${col.table}.${col.column}`, here);
      const where = `${format} ${col.table}.${col.column}`;
      assert.deepEqual(describeStored(stored), { version: format, keyId: secrets.currentKeyId, bound: true }, where);
      assert.equal(secrets.decrypt(stored, here), `value-of-${col.table}.${col.column}`, `${where} reads back`);
      assert.equal(stored.includes('value-of'), false);
      if (col.bind.includes('tenant_id')) assert.equal(codeOf(() => secrets.decrypt(stored, secretBinding(col.table, col.column, rowFor(col, 8)))), 'wrong_record', `${where}: another business`);
      // A row of a business's own table (one per business) is the business itself: another row is another business.
      if (col.bind.some((name) => name !== 'tenant_id')) assert.equal(codeOf(() => secrets.decrypt(stored, secretBinding(col.table, col.column, rowFor(col, 7, 2)))), 'wrong_record', `${where}: another row`);
      const other = SECRET_COLUMNS.find((c) => c !== col && c.bind.join() === col.bind.join()) ?? SECRET_COLUMNS.find((c) => c !== col);
      assert.equal(codeOf(() => secrets.decrypt(stored, secretBinding(other.table, other.column, { ...rowFor(other, 7), ...rowFor(col, 7) }))), 'wrong_record', `${where}: another column`);
    }
  }
  // Half a record is never a binding.
  assert.throws(() => secretBinding('ig_accounts', 'access_token_enc', { tenant_id: 1 }), /ig_user_id/);
  assert.throws(() => secretBinding('ig_accounts', 'not_a_column', { tenant_id: 1 }), /SECRET_COLUMNS/);
});

test('R2-SEC-1: the binding is in the AEAD data: removing, swapping or forging the binding id breaks the value', () => {
  const secrets = createSecrets({ dataKey: key(), secretsFormat: 'v2' });
  const a = secretBinding('gateway_keys', 'key_secret_enc', { tenant_id: 1, provider: 'razorpay' });
  const b = secretBinding('gateway_keys', 'key_secret_enc', { tenant_id: 2, provider: 'razorpay' });
  const ofA = secrets.encrypt('secret-of-a', a);
  const ofB = secrets.encrypt('secret-of-b', b);
  const [headA, ...restA] = ofA.split('.');
  const [headB] = ofB.split('.');
  assert.match(headA, /^v2~[A-Za-z0-9_-]{22}$/);
  assert.equal(codeOf(() => secrets.decrypt(['v2', ...restA].join('.'))), 'tampered', 'the binding id taken off');
  assert.equal(codeOf(() => secrets.decrypt(['v2', ...restA].join('.'), b)), 'tampered', 'taken off, then read as another business');
  assert.equal(codeOf(() => secrets.decrypt([headB, ...restA].join('.'), b)), 'tampered', 'B\'s binding id put on A\'s value');
  assert.equal(codeOf(() => secrets.decrypt(ofA, b)), 'wrong_record');
  // The same value with the binding of another column of the same business.
  assert.equal(codeOf(() => secrets.decrypt(ofA, secretBinding('shipping_settings', 'own_password_enc', { tenant_id: 1 }))), 'wrong_record');
  // A value read with no binding (a tool, the re-wrap's proof) opens as it stands.
  assert.equal(secrets.decrypt(ofA), 'secret-of-a');
  for (const error of [() => secrets.decrypt(ofA, b), () => secrets.decrypt([headB, ...restA].join('.'), b)]) {
    try {
      error();
    } catch (e) {
      assert.equal(`${e.message}${e.stack}`.includes('secret-of'), false, 'the refusal holds no value');
    }
  }
});

test('R2-SEC-1: a value written before the binding reads until binding is required; rewrap() binds it, keeping a v2 ciphertext', () => {
  const k = key();
  const legacyV1 = createSecrets({ dataKey: k }).encrypt('legacy-v1');
  const legacyV2 = createSecrets({ dataKey: k, secretsFormat: 'v2' }).encrypt('legacy-v2');
  const here = secretBinding('whatsapp_accounts', 'access_token_enc', { tenant_id: 3 });
  const during = createSecrets({ dataKey: k, secretsFormat: 'v2' });
  assert.equal(during.decrypt(legacyV1, here), 'legacy-v1', 'migration window: still read');
  assert.equal(during.decrypt(legacyV2, here), 'legacy-v2');
  const after = createSecrets({ dataKey: k, secretsFormat: 'v2', secretsRequireBinding: true });
  assert.equal(codeOf(() => after.decrypt(legacyV2, here)), 'unbound', 'after the re-wrap: refused');
  assert.equal(codeOf(() => after.decrypt(legacyV1, here)), 'unbound');
  assert.equal(after.needsRotation(legacyV2, here), true);
  const bound = after.rewrap(legacyV2, here);
  assert.deepEqual(bound.split('.').slice(1, 2), legacyV2.split('.').slice(1, 2));
  assert.deepEqual(bound.split('.').slice(5), legacyV2.split('.').slice(5), 'the v2 ciphertext is not rewritten');
  assert.equal(after.decrypt(bound, here), 'legacy-v2');
  assert.equal(after.needsRotation(bound, here), false);
  assert.equal(after.rewrap(bound, here), bound, 'nothing more to do');
  const boundV1 = after.rewrap(legacyV1, here);
  assert.deepEqual([describeStored(boundV1).version, describeStored(boundV1).bound], ['v2', true]);
  assert.equal(after.decrypt(boundV1, here), 'legacy-v1');
  // A value already bound to another record is never re-bound to this one.
  const elsewhere = secretBinding('whatsapp_accounts', 'access_token_enc', { tenant_id: 4 });
  assert.equal(after.needsRotation(bound, elsewhere), true);
  assert.equal(codeOf(() => after.rewrap(bound, elsewhere)), 'wrong_record');
});

async function world({ require = false, dataKey = key() } = {}) {
  const db = await openTestDb();
  const secrets = createSecrets({ dataKey, secretsFormat: 'v2', secretsRequireBinding: require });
  const platform = createRepos(db, { secrets });
  const q = (text, params) => (db.platform ?? db).query(text, params);
  async function make(slug) {
    const tenant = await platform.tenants.create({ slug, name: `Shop ${slug}`, plan: 't3' });
    return { tenant, repos: bindTenant(platform, tenant) };
  }
  async function connect(shop, igUserId, token) {
    await platform.tenants.linkIgAccount(shop.tenant.id, igUserId, `acct_${igUserId}`);
    await shop.repos.igAccounts.setToken(igUserId, token);
  }
  return { db, secrets, platform, q, make, connect, close: () => db.close?.() };
}

test('R2-SEC-1: through the repos, a token or key copied to another business, or to another column of the same business, gives no secret', async (t) => {
  const w = await world({ require: true });
  t.after(w.close);
  const one = await w.make('bind-one');
  const two = await w.make('bind-two');
  await w.connect(one, 'ig-bind-one', 'token-of-one-123456');
  await w.connect(two, 'ig-bind-two', 'token-of-two-123456');
  await one.repos.gatewayKeys.save('razorpay', { keyId: 'rzp_live_one11111', keySecret: 'gateway-of-one' }, 'owner');
  await two.repos.gatewayKeys.save('razorpay', { keyId: 'rzp_live_two22222', keySecret: 'gateway-of-two' }, 'owner');
  assert.equal((await one.repos.igAccounts.get('ig-bind-one')).token, 'token-of-one-123456', 'normal read');
  assert.equal((await two.repos.gatewayKeys.get('razorpay')).keySecret, 'gateway-of-two', 'normal read');

  // Business one's Instagram token, into business two's row.
  const [{ v: igOne }] = await w.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-bind-one'`);
  await w.q(`UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = 'ig-bind-two'`, [igOne]);
  assert.equal((await two.repos.igAccounts.get('ig-bind-two')).token, '', 'business two gets no token, not business one\'s');
  assert.equal((await one.repos.igAccounts.get('ig-bind-one')).token, 'token-of-one-123456', 'the owner still reads its own');

  // Business one's gateway secret, into business two's row.
  const [{ v: gwOne }] = await w.q(`SELECT key_secret_enc AS v FROM gateway_keys WHERE tenant_id = $1`, [one.tenant.id]);
  await w.q(`UPDATE gateway_keys SET key_secret_enc = $1 WHERE tenant_id = $2`, [gwOne, two.tenant.id]);
  await assert.rejects(two.repos.gatewayKeys.get('razorpay'), (e) => e.code === 'wrong_record' && !String(e.message).includes('gateway-of'));

  // Another column of the same business: the Meta CAPI token read as the GA4 secret.
  await one.repos.tagSettings.save({ meta: { pixelId: '123456', capiToken: 'capi-token-of-one' }, ga4: { measurementId: 'G-ABC123', apiSecret: 'ga4-secret-of-one' } }, { actor: 'owner', userId: null });
  const [tags] = await w.q(`SELECT tenant_id, meta_capi_token_enc, ga4_api_secret_enc FROM tag_settings WHERE tenant_id = $1`, [one.tenant.id]);
  assert.equal(w.secrets.decrypt(tags.meta_capi_token_enc, secretBinding('tag_settings', 'meta_capi_token_enc', tags)), 'capi-token-of-one');
  assert.equal(codeOf(() => w.secrets.decrypt(tags.meta_capi_token_enc, secretBinding('tag_settings', 'ga4_api_secret_enc', tags))), 'wrong_record', 'another column of the same row');
  assert.equal(codeOf(() => w.secrets.decrypt(gwOne, secretBinding('shipping_settings', 'own_password_enc', { tenant_id: one.tenant.id }))), 'wrong_record', 'another table of the same business');
});

test('R2-SEC-1: the re-wrap job binds rows written before the binding, leaves a copied value alone, and then binding can be required', async (t) => {
  const dataKey = key();
  const w = await world({ dataKey });
  t.after(w.close);
  const legacy = createSecrets({ dataKey, secretsFormat: 'v2' });
  const a = await w.make('legacy-a');
  const b = await w.make('legacy-b');
  const c = await w.make('legacy-c');
  for (const [shop, id] of [[a, 'ig-legacy-a'], [b, 'ig-legacy-b'], [c, 'ig-legacy-c']]) await w.connect(shop, id, `placeholder-${id}`);
  // As stored before R2-SEC-1: no binding.
  await w.q(`UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = 'ig-legacy-a'`, [legacy.encrypt('legacy-token-a')]);
  await w.q(`UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = 'ig-legacy-b'`, [legacy.encrypt('legacy-token-b')]);
  await w.q(`INSERT INTO gateway_keys (tenant_id, provider, key_id, key_secret_enc) VALUES ($1, 'razorpay', 'rzp_live_legacy01', $2)`, [a.tenant.id, legacy.encrypt('legacy-gateway-a')]);
  // A bound value copied to another business's row before the job ran.
  const [{ v: copied }] = await w.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-legacy-c'`);
  await w.q(`INSERT INTO fb_pages (tenant_id, page_id, name, access_token_enc, status) VALUES ($1, 'page-copied', 'Copied', $2, 'active')`, [a.tenant.id, copied]);
  assert.equal((await a.repos.igAccounts.get('ig-legacy-a')).token, 'legacy-token-a', 'during the migration an old value still reads');

  const rotation = createSecretRotation({ db: w.db, platform: { secrets: w.secrets } }, { log: { info() {}, warn() {}, error() {} } });
  await rotation.start();
  for (let i = 0; i < 200; i++) {
    const step = await rotation.step();
    if (step.finished || !step.table) break;
  }
  const rows = await w.q(`SELECT ig_user_id, tenant_id, access_token_enc AS v FROM ig_accounts WHERE ig_user_id LIKE 'ig-legacy-%'`);
  for (const row of rows) {
    assert.equal(describeStored(row.v).bound, true, `${row.ig_user_id} is bound`);
    assert.equal(w.secrets.decrypt(row.v, secretBinding('ig_accounts', 'access_token_enc', row)).startsWith(row.ig_user_id === 'ig-legacy-c' ? 'placeholder' : 'legacy-token'), true);
  }
  const [gw] = await w.q(`SELECT tenant_id, provider, key_secret_enc AS v FROM gateway_keys WHERE tenant_id = $1`, [a.tenant.id]);
  assert.equal(describeStored(gw.v).bound, true);
  const [page] = await w.q(`SELECT access_token_enc AS v FROM fb_pages WHERE page_id = 'page-copied'`);
  assert.equal(page.v, copied, 'a value bound to another record is left as it is');
  const [{ status }] = await w.q(`SELECT status FROM secret_rewraps WHERE table_name = 'fb_pages' AND column_name = 'access_token_enc'`);
  assert.equal(status, 'failed', 'and the column says so: the old key is not called free');
  assert.equal((await rotation.progress()).finished, false);

  // Now binding is required: the bound rows read, an unbound value written by a stale process does not.
  const strict = createSecrets({ dataKey, secretsFormat: 'v2', secretsRequireBinding: true });
  const strictRepos = bindTenant(createRepos(w.db, { secrets: strict }), a.tenant);
  assert.equal((await strictRepos.igAccounts.get('ig-legacy-a')).token, 'legacy-token-a');
  assert.equal((await strictRepos.gatewayKeys.get('razorpay')).keySecret, 'legacy-gateway-a');
  await w.q(`UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = 'ig-legacy-a'`, [legacy.encrypt('stale-unbound-token')]);
  assert.equal((await strictRepos.igAccounts.get('ig-legacy-a')).token, '', 'an unbound value is refused once binding is required');
});
