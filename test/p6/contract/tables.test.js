// The Phase 6 tables (migrations 600 to 608): the fence on every business table, the platform's own tables, and each rule the
// database holds behind the code, tried with SQL that goes round the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { APP_MACHINES, APP_TRANSITIONS } from '../../../src/contracts/apps.js';
import { withTenant } from '../../../src/tenancy.js';
import { REEL_ID, enableApp, seedReel } from '../../helpers.js';
import { otherBusiness, placeOrder, refusal, world } from '../../p4/contract/support.js';

const TENANT_TABLES = [
  'shopper_app_sessions', 'shopper_app_handoffs', 'app_configs', 'app_builds', 'app_submissions', 'app_submission_history', 'app_rejections', 'app_review_tasks',
  'presubmit_runs', 'store_access', 'store_listings', 'listing_assets', 'shopper_push_devices', 'shopper_push_consents', 'shopper_push_orders', 'push_campaigns',
  'shopper_push_log', 'shopper_push_events', 'app_push_credentials',
];
const INSERT_ONLY = ['app_submission_history', 'app_rejections', 'app_review_tasks', 'presubmit_runs', 'shopper_push_consents'];
const PLATFORM_TABLES = ['app_runtimes', 'app_build_batches', 'ota_releases', 'ota_health'];
const PASSWORD_LIKE = /pass(word|code|wd)|^pass$|pwd|secret_plain/i;

const sql = (w, text, params) => w.db.platform.query(text, params);
const asBusiness = (w, text, params, tenant = w.tenant) => withTenant(tenant, () => w.db.query(text, params));
/** A refusal by a unique key or index, by its constraint name or the driver's words. */
const UNIQUE = /unique|duplicate|_key$|_idx$|_one_running$|_token$|_one_active$/;
const key = (prefix = 'key') => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

async function runtime(w, version = '1.0.0') {
  await sql(w, `INSERT INTO app_runtimes (runtime_version, fingerprint, app_version) VALUES ($1, $2, '1.0.0') ON CONFLICT DO NOTHING`, [version, `fp-${version}-native`]);
}
async function batch(w, tenant = w.tenant) {
  await runtime(w);
  const [row] = await sql(w, `INSERT INTO app_build_batches (reason, tenant_id, app_version, runtime_version, requested_by, request_key) VALUES ('brand', $1, '1.0.0', '1.0.0', 'system', $2) RETURNING id`, [tenant.id, key('batch')]);
  return row.id;
}
async function build(w, { platform = 'android', number = 1, status = 'queued', requestKey = key(), tenant = w.tenant } = {}) {
  const batchId = await batch(w, tenant);
  const [row] = await asBusiness(w,
    `INSERT INTO app_builds (tenant_id, batch_id, reason, platform, app_version, build_number, runtime_version, driver, status, request_key, requested_by)
     VALUES ($1, $2, 'brand', $3, '1.0.0', $4, '1.0.0', 'local', $5, $6, 'user:1') RETURNING *`,
    [tenant.id, batchId, platform, number, status, requestKey], tenant);
  return row;
}
const presubmit = (w, buildId, passed) => asBusiness(w, `INSERT INTO presubmit_runs (tenant_id, build_id, platform, passed, checks) VALUES ($1, $2, 'android', $3, '[]')`, [w.tenant.id, buildId, passed]);
const moveTo = (w, id, state) => asBusiness(w, `UPDATE app_submissions SET state = $3, changed_by = 'provider:play' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, id, state]);
const reject = (w, submissionId, guideline, providerKey) => asBusiness(w,
  `INSERT INTO app_rejections (tenant_id, submission_id, platform, guideline, message, provider_key) VALUES ($1, $2, 'android', $3, 'Please change it.', $4)`,
  [w.tenant.id, submissionId, guideline, providerKey]);
const openTasks = (w) => sql(w, `SELECT guideline_key FROM app_review_tasks WHERE tenant_id = $1 AND status = 'open'`, [w.tenant.id]);

test('every Phase 6 business table is fenced, the platform tables refuse the app login, and app_transitions equals APP_TRANSITIONS', async () => {
  const w = await world();
  const tables = await w.db.query(
    `SELECT c.relname AS name, c.relrowsecurity AS fenced,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
            has_table_privilege('bhava_app', c.oid, 'SELECT') AS app_reads, has_table_privilege('bhava_app', c.oid, 'INSERT') AS app_inserts,
            has_table_privilege('bhava_app', c.oid, 'UPDATE') AS app_updates, has_table_privilege('bhava_app', c.oid, 'DELETE') AS app_deletes
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const name of TENANT_TABLES) {
    const t = byName.get(name);
    assert.ok(t, `${name} exists`);
    assert.deepEqual([t.has_tenant, t.fenced, t.app_reads, t.app_inserts], [true, true, true, true], `${name} has tenant_id, the fence and a grant`);
    if (INSERT_ONLY.includes(name)) assert.deepEqual([t.app_updates, t.app_deletes], [false, false], `${name} is insert-only for business code`);
  }
  for (const name of ['shopper_push_log', 'shopper_push_events']) assert.deepEqual([byName.get(name).app_updates, byName.get(name).app_deletes], [true, false], name);
  for (const name of PLATFORM_TABLES) assert.equal(byName.get(name)?.app_reads, false, `${name} is the platform's alone`);
  assert.equal(byName.get('app_build_batches').fenced, true, 'it names a business, so it is fenced as well');
  assert.deepEqual([byName.get('app_transitions').app_reads, byName.get('app_transitions').app_inserts], [true, false], 'shared reference data');
  await assert.rejects(() => asBusiness(w, 'SELECT 1 FROM ota_releases'), /permission denied/);
  await assert.rejects(() => asBusiness(w, 'SELECT 1 FROM app_build_batches'), /permission denied/);

  const rows = await w.db.platform.query('SELECT machine, from_status, to_status, guard FROM app_transitions');
  const inCode = APP_MACHINES.flatMap((machine) => APP_TRANSITIONS[machine].map((m) => ({ machine, from_status: m.from, to_status: m.to, guard: m.guard })));
  const order = (list) => list.map((r) => `${r.machine} ${r.from_status} ${r.to_status} ${r.guard}`).sort();
  assert.deepEqual(order(rows), order(inCode));

  // One business cannot see, change or link to another's rows.
  await enableApp(w);
  const other = await otherBusiness(w);
  const [media] = await asBusiness(w, `INSERT INTO media (tenant_id, mime, storage_key, size) VALUES ($1, 'image/png', 'media/icon.png', 4) RETURNING id`, [w.tenant.id]);
  assert.deepEqual(await other.inTenant(() => w.db.query('SELECT tenant_id FROM app_configs')), [], 'the fence, with no WHERE');
  assert.match(String(await refusal(other.inTenant(() => w.db.query('INSERT INTO app_configs (tenant_id, icon_media_id) VALUES ($1, $2)', [other.tenant.id, media.id])))), /fkey/, 'no icon of another business');
  const mine = await build(w, { status: 'built' });
  assert.match(String(await refusal(other.inTenant(() => w.db.query(`INSERT INTO app_submissions (tenant_id, platform, build_id) VALUES ($1, 'android', $2)`, [other.tenant.id, mine.id])))), /fkey/, 'no build of another business');
  const changed = await other.inTenant(() => w.db.query(`UPDATE app_configs SET app_name = 'Taken' RETURNING tenant_id`));
  assert.deepEqual(changed, []);
});

test('no Phase 6 column is named like a password, and every encrypted column holds only the encrypted form', async () => {
  const w = await world();
  const columns = await sql(w, `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)`, [[...TENANT_TABLES, ...PLATFORM_TABLES, 'app_transitions']]);
  assert.ok(columns.length > 100);
  assert.deepEqual(columns.filter((c) => PASSWORD_LIKE.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`), []);
  const encrypted = columns.filter((c) => c.column_name.endsWith('_enc'));
  assert.deepEqual(encrypted.map((c) => `${c.table_name}.${c.column_name}`).sort(), ['app_push_credentials.apns_key_enc', 'app_push_credentials.fcm_service_account_enc', 'shopper_push_devices.token_enc', 'store_access.key_enc']);
  const checks = await sql(w, `SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c' AND conrelid::regclass::text = ANY($1)`, [encrypted.map((c) => c.table_name)]);
  for (const { table_name: table, column_name: column } of encrypted) {
    assert.ok(checks.some((c) => c.table_name === table && c.def.includes(column) && c.def.includes("'v1.%'")), `${table}.${column} has the v1.% check`);
  }
  await enableApp(w);
  assert.match(String(await refusal(asBusiness(w, `INSERT INTO store_access (tenant_id, platform, credential_kind, key_enc) VALUES ($1, 'ios', 'asc_api_key', '-----BEGIN PRIVATE KEY-----')`, [w.tenant.id]))), /check/, 'a .p8 is never stored in the clear'); // secret-scan:allow (a made-up key header)
  assert.match(String(await refusal(asBusiness(w, `INSERT INTO store_access (tenant_id, platform, credential_kind) VALUES ($1, 'android', 'asc_api_key')`, [w.tenant.id]))), /check/, 'an App Store key is iOS only');
});

test('a submission moves only along app_transitions: no skipping, review needs a passed pre-submit run, and two rejections open one task', async () => {
  const w = await world();
  await enableApp(w);
  const built = await build(w, { status: 'built' });
  const [submission] = await asBusiness(w, `INSERT INTO app_submissions (tenant_id, platform, build_id) VALUES ($1, 'android', $2) RETURNING id, state`, [w.tenant.id, built.id]);
  assert.equal(submission.state, 'draft');
  assert.equal(await refusal(moveTo(w, submission.id, 'approved')), 'app_submissions_transition', 'a submission cannot skip review');
  assert.equal(await refusal(moveTo(w, submission.id, 'in_review')), 'app_submissions_guard', 'no pre-submit run');
  await presubmit(w, built.id, false);
  assert.equal(await refusal(moveTo(w, submission.id, 'in_review')), 'app_submissions_guard', 'a failed pre-submit run (P-59)');
  await presubmit(w, built.id, true);
  await moveTo(w, submission.id, 'in_review');
  const history = await sql(w, 'SELECT from_state, to_state, actor FROM app_submission_history WHERE tenant_id = $1 AND submission_id = $2', [w.tenant.id, submission.id]);
  assert.deepEqual(history, [{ from_state: 'draft', to_state: 'in_review', actor: 'provider:play' }], 'the database writes the history');

  await moveTo(w, submission.id, 'rejected');
  await reject(w, submission.id, '4.3(a)', 'r-1');
  assert.match(String(await refusal(reject(w, submission.id, '4.3(a)', 'r-1'))), UNIQUE, 'read twice, stored once');
  assert.deepEqual(await openTasks(w), [], 'one rejection opens no task');
  await moveTo(w, submission.id, 'in_review');
  await moveTo(w, submission.id, 'rejected');
  await reject(w, submission.id, '4.3', 'r-2');
  assert.deepEqual(await openTasks(w), [{ guideline_key: '4.3' }], 'the second on one guideline opens a task (P-60)');
  assert.equal(await refusal(moveTo(w, submission.id, 'in_review')), 'app_submissions_guard', 'and blocks resubmission');
  await reject(w, submission.id, '4.3(b)', 'r-3');
  assert.equal((await openTasks(w)).length, 1, 'a third opens no second task');
  await assert.rejects(() => asBusiness(w, `UPDATE app_review_tasks SET status = 'resolved', resolved_at = now() WHERE tenant_id = $1`, [w.tenant.id]), /permission denied/, 'a business cannot close its own task');
  await sql(w, `UPDATE app_review_tasks SET status = 'resolved', resolved_at = now(), resolved_by = 'platform:1' WHERE tenant_id = $1`, [w.tenant.id]);
  await moveTo(w, submission.id, 'in_review');
  await reject(w, submission.id, '4.3', 'r-4');
  assert.deepEqual(await openTasks(w), [], 'rejections before the resolution no longer count');
  assert.equal(await refusal(asBusiness(w, `UPDATE app_submissions SET platform = 'ios' WHERE tenant_id = $1`, [w.tenant.id])), 'app_submissions_transition');
});

test('builds: one number per business and platform, one build per request, one running per platform, and the store ids lock after a submit', async () => {
  const w = await world();
  await enableApp(w);
  const first = await build(w, { number: 1, status: 'queued' });
  assert.match(String(await refusal(build(w, { number: 2, status: 'queued' }))), UNIQUE, 'a second running build per platform');
  await build(w, { platform: 'ios', number: 1, status: 'queued' });
  assert.match(String(await refusal(build(w, { number: 1, status: 'built' }))), UNIQUE, 'a build number repeats nowhere');
  assert.match(String(await refusal(build(w, { number: 3, status: 'built', requestKey: first.request_key }))), UNIQUE, 'the same request is one build');
  const update = (set, params = []) => asBusiness(w, `UPDATE app_builds SET ${set} WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, first.id, ...params]);
  assert.equal(await refusal(update(`status = 'built'`)), 'app_builds_transition', 'queued cannot skip building');
  assert.equal(await refusal(update('build_number = 9')), 'app_builds_fixed');
  assert.match(String(await refusal(update(`status = 'failed'`))), /check/, 'failing names its step');
  await update(`status = 'building'`);
  await update(`status = 'built'`);
  const config = () => sql(w, 'SELECT android_package, android_locked_at, ios_locked_at FROM app_configs WHERE tenant_id = $1', [w.tenant.id]);
  await asBusiness(w, `UPDATE app_configs SET android_package = 'com.example.renamed' WHERE tenant_id = $1`, [w.tenant.id]);
  await update(`status = 'submitted'`);
  const locked = (await config())[0];
  assert.ok(locked.android_locked_at, 'the first submitted build locks the Android ids');
  assert.equal(locked.ios_locked_at, null);
  assert.equal(await refusal(asBusiness(w, `UPDATE app_configs SET android_package = 'com.example.again' WHERE tenant_id = $1`, [w.tenant.id])), 'app_configs_locked', 'P-17: no change after a submit');
  assert.equal(await refusal(asBusiness(w, `UPDATE app_configs SET url_scheme = 'another' WHERE tenant_id = $1`, [w.tenant.id])), 'app_configs_locked');
  assert.equal(await refusal(asBusiness(w, 'UPDATE app_configs SET android_locked_at = NULL WHERE tenant_id = $1', [w.tenant.id])), 'app_configs_locked');
  await asBusiness(w, 'UPDATE app_configs SET android_next_build = 5 WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal(await refusal(asBusiness(w, 'UPDATE app_configs SET android_next_build = 4 WHERE tenant_id = $1', [w.tenant.id])), 'app_configs_locked', 'build numbers never go down');

  const other = await otherBusiness(w);
  assert.match(String(await refusal(enableApp(w, { tenant: other.tenant, config: { android_package: 'com.example.renamed' } }))), UNIQUE, 'no two businesses share a package');
  assert.match(String(await refusal(enableApp(w, { tenant: other.tenant, config: { ios_bundle_id: `COM.EXAMPLE.T${w.tenant.id}` } }))), UNIQUE, 'nor a bundle id, whatever its case');
  assert.match(String(await refusal(enableApp(w, { tenant: other.tenant, config: { url_scheme: `shop${w.tenant.id}` } }))), UNIQUE, 'nor a link scheme');
  assert.match(String(await refusal(enableApp(w, { tenant: other.tenant, config: { app_name: 'Bhava Shop' } }))), /check/, 'an app name never names the platform');
});

test('over-the-air releases: rollout goes 10, 50, 100 only while live, one active per runtime, a blocked release never moves', async () => {
  const w = await world();
  await runtime(w, '2.0.0');
  const insert = (status = 'publishing', blockReason = '') => sql(w,
    `INSERT INTO ota_releases (runtime_version, bundle_fingerprint, bundle_id, bundle_hash, status, block_reason, published_by, request_key)
     VALUES ('2.0.0', 'fp-2.0.0-native', $1, $2, $3, $4, 'platform:1', $5) RETURNING id, rollout`,
    [key('group'), crypto.randomBytes(32).toString('hex'), status, blockReason, key('publish')]);
  const [release] = await insert();
  assert.equal(release.rollout, 10);
  const set = (id, change) => sql(w, `UPDATE ota_releases SET ${change} WHERE id = $1`, [id]);
  assert.equal(await refusal(set(release.id, 'rollout = 50')), 'ota_releases_rollout', 'not while publishing');
  await set(release.id, `status = 'live'`);
  assert.equal(await refusal(set(release.id, 'rollout = 100')), 'ota_releases_rollout', 'no jump from 10 to 100');
  await set(release.id, 'rollout = 50');
  assert.match(String(await refusal(insert())), UNIQUE, 'two active releases on one runtime');
  const [blocked] = await insert('blocked', 'native_change');
  assert.equal(await refusal(set(blocked.id, `status = 'live'`)), 'ota_releases_transition', 'a blocked release never moves');
  assert.equal(await refusal(set(release.id, `bundle_id = 'other-group'`)), 'ota_releases_fixed');
  await set(release.id, `status = 'rolling_back', rollback_reason = 'crash_rate'`);
  assert.equal(await refusal(set(release.id, 'rollout = 100')), 'ota_releases_rollout', 'never moves during a roll back');
  await set(release.id, `status = 'rolled_back', rolled_back_at = now()`);
  assert.match(String(await refusal(sql(w, `INSERT INTO ota_health (release_id, hour, launches) VALUES ($1, '2026-11-12T10:30:00Z', 1)`, [release.id]))), /check/, 'health is per hour');
});

test('orders keep their channel, an app-only coupon is never redeemed on a web order, and a push token needs a granted permission', async () => {
  const w = await world();
  const web = await placeOrder(w);
  assert.equal(web.channel, 'web');
  assert.equal(await refusal(asBusiness(w, `UPDATE orders SET channel = 'app' WHERE tenant_id = $1 AND id = $2`, [w.tenant.id, web.id])), 'orders_channel_fixed');
  const inApp = await placeOrder(w, { order: { channel: 'app' } });
  const [coupon] = await asBusiness(w, `INSERT INTO coupons (tenant_id, code, kind, amount_paise, app_only) VALUES ($1, 'APPONLY', 'flat', 5000, true) RETURNING id`, [w.tenant.id]);
  const redeem = (orderId) => asBusiness(w, `INSERT INTO coupon_redemptions (tenant_id, coupon_id, order_id, customer_key, discount_paise) VALUES ($1, $2, $3, $4, 5000)`, [w.tenant.id, coupon.id, orderId, 'c'.repeat(64)]);
  assert.equal(await refusal(redeem(web.id)), 'coupon_app_only', 'P-63, in the database');
  await redeem(inApp.id);

  const device = (deviceId, permission, token = 'h1') => asBusiness(w,
    `INSERT INTO shopper_push_devices (tenant_id, device_id, platform, token_enc, token_hash, permission) VALUES ($1, $2, 'android', 'v1.k.iv.tag.ct', $3, $4) RETURNING id`,
    [w.tenant.id, deviceId, token, permission]);
  assert.match(String(await refusal(device('device-0123456789abcd01', 'not_asked'))), /check/, 'no token without the system permission');
  assert.match(String(await refusal(device('device-0123456789abcd01', 'denied'))), /check/);
  await device('device-0123456789abcd01', 'granted');
  assert.match(String(await refusal(device('device-0123456789abcd02', 'granted'))), UNIQUE, 'one token is one device');
  const [plain] = await asBusiness(w, `INSERT INTO shopper_push_devices (tenant_id, device_id, platform) VALUES ($1, 'device-0123456789abcd03', 'ios') RETURNING order_updates_on_at, offers_on_at, new_reels_on_at, permission`, [w.tenant.id]);
  assert.deepEqual(plain, { order_updates_on_at: null, offers_on_at: null, new_reels_on_at: null, permission: 'not_asked' }, 'registering never opts in');
});

test('app_configs mirrors its minimum version into app_min_versions, the one table the version gates read, and takes it away', async () => {
  const w = await world();
  await enableApp(w);
  const minimum = async () => {
    const found = await w.platform.appVersions.minimum({ app: 'shopper', platform: 'android', tenantId: w.tenant.id });
    return found ? { minVersion: found.minVersion, storeUrl: found.storeUrl } : null;
  };
  assert.equal(await minimum(), null);
  const storeUrl = `https://play.google.com/store/apps/details?id=com.example.t${w.tenant.id}`;
  await asBusiness(w, 'UPDATE app_configs SET android_min_version = $2, android_store_url = $3 WHERE tenant_id = $1', [w.tenant.id, '1.2.0', storeUrl]);
  assert.deepEqual(await minimum(), { minVersion: '1.2.0', storeUrl }, 'written by the business, through the definer function');
  await asBusiness(w, `UPDATE app_configs SET android_min_version = '1.3.0' WHERE tenant_id = $1`, [w.tenant.id]);
  assert.equal((await minimum()).minVersion, '1.3.0');
  await asBusiness(w, `UPDATE app_configs SET android_store_url = '' WHERE tenant_id = $1`, [w.tenant.id]);
  assert.equal(await minimum(), null, 'either value empty takes the minimum away');
  assert.match(String(await refusal(asBusiness(w, `UPDATE app_configs SET ios_store_url = 'https://example.com/app' WHERE tenant_id = $1`, [w.tenant.id]))), /check/);
});

test('app sessions: a guest family, families and sessions bound to one business, and erasing a shopper ends them all', async () => {
  const w = await world();
  const other = await otherBusiness(w);
  const [person] = await sql(w, `INSERT INTO people (name) VALUES ('P') RETURNING id`);
  const [guest] = await sql(w, `INSERT INTO token_families (subject_kind, tenant_id, device_id, app_platform) VALUES ('shopper', $1, 'device-0123456789abcdef', 'android') RETURNING id`, [w.tenant.id]);
  assert.ok(guest.id, 'a shopper family with no shopper is a guest install');
  assert.match(String(await refusal(sql(w, `INSERT INTO token_families (subject_kind, person_id, tenant_id) VALUES ('user', $1, $2)`, [person.id, w.tenant.id]))), /check/, 'a seller family names no business');
  const [shopper] = await asBusiness(w, `INSERT INTO shoppers (tenant_id, phone) VALUES ($1, '+919876500011') RETURNING id`, [w.tenant.id]);
  const [apple] = await asBusiness(w, `INSERT INTO shoppers (tenant_id, apple_sub) VALUES ($1, '001234.sim') RETURNING id`, [w.tenant.id]);
  assert.ok(apple.id, 'an Apple-only shopper has an identity');
  assert.match(String(await refusal(asBusiness(w, `INSERT INTO shoppers (tenant_id, apple_sub) VALUES ($1, '001234.sim')`, [w.tenant.id]))), UNIQUE);
  assert.match(String(await refusal(sql(w, `INSERT INTO token_families (subject_kind, tenant_id, shopper_id) VALUES ('shopper', $1, $2)`, [other.tenant.id, shopper.id]))), /fkey|_fk$/, 'a family cannot name another business\'s shopper');
  const [family] = await sql(w, `INSERT INTO token_families (subject_kind, tenant_id, shopper_id) VALUES ('shopper', $1, $2) RETURNING id`, [w.tenant.id, shopper.id]);
  const session = (tenant, familyId, shopperId, method, hash = crypto.randomBytes(32).toString('base64url')) => sql(w,
    `INSERT INTO shopper_app_sessions (tenant_id, family_id, shopper_id, device_id, platform, method, token_hash, expires_at) VALUES ($1, $2, $3, 'device-0123456789abcdef', 'android', $4, $5, now() + interval '15 minutes') RETURNING id`,
    [tenant.id, familyId, shopperId, method, hash]);
  assert.match(String(await refusal(session(other.tenant, family.id, null, 'guest'))), /fkey/, 'a session cannot hang off another business\'s family');
  assert.match(String(await refusal(session(w.tenant, guest.id, shopper.id, 'guest'))), /check/, 'a guest session names no shopper');
  assert.match(String(await refusal(session(w.tenant, family.id, null, 'whatsapp_otp'))), /check/, 'a signed-in session names its shopper');
  assert.match(String(await refusal(session(w.tenant, family.id, shopper.id, 'whatsapp_otp', 'short'))), /check/, 'a token is stored as its hash');
  await session(w.tenant, guest.id, null, 'guest');
  await session(w.tenant, family.id, shopper.id, 'whatsapp_otp');
  await sql(w, `INSERT INTO refresh_tokens (family_id, token_hash, tenant_id, expires_at) VALUES ($1, 'shopper-refresh-hash', $2, now() + interval '90 days')`, [family.id, w.tenant.id]);
  assert.deepEqual(await other.inTenant(() => w.db.query('SELECT id FROM shopper_app_sessions')), [], 'the fence');
  await asBusiness(w, 'DELETE FROM shoppers WHERE tenant_id = $1 AND id = $2', [w.tenant.id, shopper.id]);
  assert.deepEqual(await sql(w, 'SELECT id FROM token_families WHERE id = $1', [family.id]), [], 'erasure ends the families');
  assert.deepEqual(await sql(w, 'SELECT id FROM shopper_app_sessions WHERE tenant_id = $1 AND shopper_id IS NOT NULL', [w.tenant.id]), [], 'and their app sessions');
  assert.equal((await sql(w, 'SELECT count(*)::int AS n FROM shopper_app_sessions WHERE family_id = $1', [guest.id]))[0].n, 1, 'a guest install is untouched');
});

test('loyalty comes with either app, and a reel joining a category writes one push event for a business with an app', async () => {
  const w = await world();
  await sql(w, `UPDATE tenants SET plan = 'free' WHERE id = $1`, [w.tenant.id]);
  assert.equal(await w.repos.entitlements.can('loyalty'), false);
  await w.repos.entitlements.setOverride('app.ios', { enabled: true });
  assert.equal(await w.repos.entitlements.can('loyalty'), true, 'loyalty is included with the app');
  assert.equal(await w.repos.entitlements.limit('loyalty'), Infinity);
  await w.repos.entitlements.setOverride('app.ios', { enabled: false });
  assert.equal(await w.repos.entitlements.can('loyalty'), false);

  await seedReel(w.repos, { n: 1 });
  const [reel] = await asBusiness(w, 'SELECT id FROM reels WHERE tenant_id = $1 AND ig_media_id = $2', [w.tenant.id, REEL_ID]);
  const [category] = await asBusiness(w, `INSERT INTO categories (tenant_id, name, slug) VALUES ($1, 'Kurtas', 'kurtas') RETURNING id`, [w.tenant.id]);
  const join = (position = 0) => asBusiness(w, 'INSERT INTO category_reels (tenant_id, category_id, page_id, position) VALUES ($1, $2, $3, $4)', [w.tenant.id, category.id, reel.id, position]);
  const events = () => sql(w, 'SELECT category_id, page_id FROM shopper_push_events WHERE tenant_id = $1', [w.tenant.id]);
  await join();
  assert.deepEqual(await events(), [], 'no app, no event');
  await asBusiness(w, 'DELETE FROM category_reels WHERE tenant_id = $1', [w.tenant.id]);
  await enableApp(w);
  await join();
  assert.deepEqual(await events(), [{ category_id: category.id, page_id: reel.id }]);
  await asBusiness(w, 'DELETE FROM category_reels WHERE tenant_id = $1', [w.tenant.id]);
  await join(1);
  assert.equal((await events()).length, 1, 'removed and added again is still one push');
});
