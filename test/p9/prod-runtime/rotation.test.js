// Master-key rotation under attack (PRD 5.15, F-66): the re-wrap job moves every stored secret to the new key in small
// batches, under concurrent reads and writes, through a crash mid-batch and past a broken value, never leaving a value
// readable by neither key, and lets the old key go only when nothing uses it. Logs and metrics carry no value or key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { REWRAP_JOB, RewrapProgress, SECRET_COLUMNS } from '../../../src/contracts/secrets.js';
import { createSecretRotation, secretRotation } from '../../../src/modules/secret-rotation/index.js';
import { setLogSink } from '../../../src/platform/log.js';
import { createSecrets, describeStored } from '../../../src/platform/secrets.js';
import { createRepos } from '../../../src/repos/index.js';
import { openTestDb } from '../../helpers.js';

const key = () => crypto.randomBytes(32).toString('base64');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plainFor = (i, round = 0) => `ig-token-${i}-${round}-${crypto.randomBytes(6).toString('hex')}`;
const restoreSink = () => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));

async function world(t, { rows = 10 } = {}) {
  const db = await openTestDb();
  t.after(() => db.close());
  const sql = (text, params) => (db.platform ?? db).query(text, params);
  const repos = createRepos(db, {});
  const one = await repos.tenants.ensure({ slug: 'rotation-one', name: 'Rotation One' });
  const two = await repos.tenants.ensure({ slug: 'rotation-two', name: 'Rotation Two' });
  const k1 = key();
  const k2 = key();
  const oldV1 = createSecrets({ dataKey: k1 });
  const oldV2 = createSecrets({ dataKey: k1, secretsFormat: 'v2' });
  const expected = new Map();
  for (let i = 0; i < rows; i++) {
    const id = `1784140000${String(i).padStart(4, '0')}`;
    const plain = plainFor(i);
    expected.set(id, plain);
    // Half in the old v1 form, half already envelopes under the old key.
    await sql('INSERT INTO ig_accounts (ig_user_id, tenant_id, username, access_token_enc) VALUES ($1, $2, $3, $4)', [id, i % 2 ? two.id : one.id, `shop${i}`, (i % 2 ? oldV1 : oldV2).encrypt(plain)]);
  }
  // A row with no token is left alone.
  await sql(`INSERT INTO ig_accounts (ig_user_id, tenant_id, username, access_token_enc) VALUES ('17841499999999', $1, 'empty', '')`, [one.id]);
  const gateways = new Map();
  for (const [tenant, provider] of [[one, 'razorpay'], [one, 'cashfree'], [two, 'razorpay']]) {
    const plain = `gateway-secret-${tenant.id}-${provider}`;
    gateways.set(`${tenant.id},${provider}`, plain);
    await sql('INSERT INTO gateway_keys (tenant_id, provider, key_id, key_secret_enc) VALUES ($1, $2, $3, $4)', [tenant.id, provider, 'key-id-sample', oldV1.encrypt(plain)]);
  }
  const current = createSecrets({ dataKey: k2, dataKeyOld: k1, secretsFormat: 'v2' });
  const onlyNew = createSecrets({ dataKey: k2, secretsFormat: 'v2' });
  const counted = [];
  const enqueued = [];
  const ctx = (secrets = current, overrides = {}) => ({
    db,
    platform: { secrets, metrics: { inc: (name, labels, n) => counted.push({ name, labels, n }) }, queue: { enqueue: async (name) => (enqueued.push(name), '1') } },
    ...overrides,
  });
  const igValues = async () => new Map((await sql(`SELECT ig_user_id, access_token_enc FROM ig_accounts WHERE access_token_enc <> '' ORDER BY ig_user_id`)).map((r) => [r.ig_user_id, r.access_token_enc]));
  const gwValues = async () => new Map((await sql('SELECT tenant_id, provider, key_secret_enc FROM gateway_keys')).map((r) => [`${r.tenant_id},${r.provider}`, r.key_secret_enc]));
  return { db, sql, one, two, k1, k2, oldV1, oldV2, current, onlyNew, expected, gateways, ctx, counted, enqueued, igValues, gwValues };
}

async function runToEnd(rotation, max = 500) {
  for (let i = 0; i < max; i++) {
    const r = await rotation.step();
    if (r.finished) return r;
  }
  assert.fail('the rotation did not finish');
}

test('every stored secret moves to the new key in small batches; the columns read as ciphertext only; the old key may then go', async (t) => {
  const w = await world(t);
  const lines = [];
  setLogSink((line) => lines.push(line));
  t.after(restoreSink);
  const rotation = createSecretRotation(w.ctx(), { batch: 3 });

  const started = await rotation.start();
  assert.ok(RewrapProgress.safeParse(started).success);
  assert.deepEqual([started.keyId, started.format, started.finished], [w.current.currentKeyId, 'v2', false]);
  assert.equal(started.columns.length, SECRET_COLUMNS.length);
  assert.deepEqual(w.enqueued, [REWRAP_JOB]);
  assert.equal((await rotation.retirable()).ok, false, 'not before the job has run');

  // Small batches: the ig_accounts walk takes several steps, each moving the place it reached.
  const places = new Set();
  let steps = 0;
  for (;;) {
    const r = await rotation.step();
    steps += 1;
    if (r.table === 'ig_accounts') {
      assert.ok(r.done + r.skipped <= 3);
      places.add((await w.sql(`SELECT last_id FROM secret_rewraps WHERE table_name = 'ig_accounts'`))[0].last_id);
    }
    if (r.finished) break;
    assert.ok(steps < 200);
  }
  assert.ok(places.size >= 3, 'the walk went in batches');

  for (const [id, stored] of await w.igValues()) {
    assert.deepEqual(describeStored(stored), { version: 'v2', keyId: w.current.currentKeyId }, id);
    assert.equal(w.onlyNew.decrypt(stored), w.expected.get(id), 'readable with the new key alone');
    assert.ok(!stored.includes(w.expected.get(id)), 'ciphertext only');
  }
  for (const [pk, stored] of await w.gwValues()) assert.equal(w.onlyNew.decrypt(stored), w.gateways.get(pk));
  assert.equal((await w.sql(`SELECT access_token_enc FROM ig_accounts WHERE ig_user_id = '17841499999999'`))[0].access_token_enc, '', 'an empty value stays empty');

  const progress = await rotation.progress();
  assert.ok(RewrapProgress.safeParse(progress).success);
  assert.equal(progress.finished, true);
  assert.ok(progress.columns.every((c) => c.status === 'done'));
  const ig = progress.columns.find((c) => c.table === 'ig_accounts');
  assert.equal(ig.done, w.expected.size);
  assert.ok(ig.lastId.length === 8 && ![...w.expected.keys()].some((id) => ig.lastId.includes(id)), 'the place is a hash, never an account id');
  const gw = progress.columns.find((c) => c.table === 'gateway_keys');
  assert.ok(!gw.lastId.includes(String(w.two.id)) || gw.lastId.length === 8);
  assert.deepEqual(await rotation.retirable(), { ok: true, remaining: [], oldKeyIds: [createSecrets({ dataKey: w.k1 }).currentKeyId] });

  // Running it again does nothing and finds nothing.
  const again = await rotation.step();
  assert.deepEqual([again.table, again.finished], [null, true]);

  // Nothing secret in the logs or the counts: no value, no key, no business.
  const text = lines.join('\n') + JSON.stringify(w.counted);
  for (const plain of [...w.expected.values(), ...w.gateways.values()]) assert.ok(!text.includes(plain));
  for (const k of [w.k1, w.k2]) assert.ok(!text.includes(k) && !text.includes(Buffer.from(k, 'base64').toString('base64url')));
  for (const word of ['rotation-one', 'Rotation One', ...w.expected.keys()]) assert.ok(!text.includes(word), word);
  assert.ok(w.counted.every((c) => c.name === 'secret_rewrap_rows_total' && ['rewrapped', 'skipped', 'failed'].includes(c.labels.result)));
  assert.equal(w.counted.filter((c) => c.labels.result === 'rewrapped').reduce((n, c) => n + c.n, 0), w.expected.size + w.gateways.size);
});

test('under concurrent reads and writes, from new and old processes, nothing is lost and every value always reads', async (t) => {
  const w = await world(t, { rows: 24 });
  restoreSink();
  setLogSink(() => {});
  t.after(restoreSink);
  const ids = [...w.expected.keys()];
  // Two workers walking at once, a process on the new key and one still on the old key writing, readers throughout.
  const workerA = createSecretRotation(w.ctx(), { batch: 4 });
  const workerB = createSecretRotation(w.ctx(), { batch: 4 });
  await workerA.start();
  const newPod = createSecrets({ dataKey: w.k2, dataKeyOld: w.k1, secretsFormat: 'v2' });
  const oldPod = createSecrets({ dataKey: w.k1 });
  let writing = true;
  let reads = 0;
  const readFailures = [];

  const writer = (async () => {
    for (let round = 1; round <= 60; round++) {
      const id = ids[(round * 7) % ids.length];
      const plain = plainFor(id, round);
      const pod = round % 3 === 0 ? oldPod : newPod;
      await w.sql('UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = $2', [pod.encrypt(plain), id]);
      w.expected.set(id, plain);
      await pause(1);
    }
    writing = false;
  })();
  const reader = (async () => {
    while (writing) {
      for (const [id, stored] of await w.igValues()) {
        try {
          newPod.decrypt(stored);
          reads += 1;
        } catch {
          readFailures.push(id);
        }
      }
      await pause(1);
    }
  })();
  const walk = async (worker) => {
    while (writing) {
      await worker.step();
      await pause(1);
    }
  };
  await Promise.all([writer, reader, walk(workerA), walk(workerB)]);
  assert.deepEqual(readFailures, [], 'no read ever failed');
  assert.ok(reads > 0);

  // The old process stops (the deploy finished); started again, the job finishes the stragglers it wrote.
  await workerA.start();
  await runToEnd(workerA);
  for (const [id, stored] of await w.igValues()) {
    assert.deepEqual(describeStored(stored), { version: 'v2', keyId: w.current.currentKeyId });
    assert.equal(w.onlyNew.decrypt(stored), w.expected.get(id), `the last write to ${id} is the value`);
  }
  assert.equal((await workerB.retirable()).ok, true);
});

test('a crash mid-batch loses nothing and leaves nothing unreadable; the job carries on from where it was', async (t) => {
  const w = await world(t, { rows: 9 });
  setLogSink(() => {});
  t.after(restoreSink);
  const before = await w.igValues();
  // The database connection dies on the second write of a batch.
  let writes = 0;
  const crashing = {
    ...w.db,
    platform: {
      ...(w.db.platform ?? w.db),
      tx: (fn) => (w.db.platform ?? w.db).tx((t2) => fn({
        ...t2,
        query: async (text, params) => {
          if (/^UPDATE "ig_accounts"/.test(text) && ++writes === 2) throw new Error('Connection terminated unexpectedly');
          return t2.query(text, params);
        },
      })),
    },
  };
  const broken = createSecretRotation(w.ctx(w.current, { db: crashing }), { batch: 4 });
  await broken.start();
  let crashed = false;
  for (let i = 0; i < 100 && !crashed; i++) {
    try {
      await broken.step();
    } catch {
      crashed = true;
    }
  }
  assert.ok(crashed);
  // The batch rolled back whole: every value is as it was, under the old key, and the place did not move.
  assert.deepEqual(await w.igValues(), before);
  const [place] = await w.sql(`SELECT last_id, rows_done, status FROM secret_rewraps WHERE table_name = 'ig_accounts'`);
  assert.deepEqual([place.last_id, Number(place.rows_done)], ['', 0]);
  for (const stored of before.values()) w.current.decrypt(stored);

  // A fresh worker resumes and finishes; every value reads with the new key alone.
  const resumed = createSecretRotation(w.ctx(), { batch: 4 });
  await runToEnd(resumed);
  for (const [id, stored] of await w.igValues()) assert.equal(w.onlyNew.decrypt(stored), w.expected.get(id));
  assert.equal((await resumed.retirable()).ok, true);
});

test('a value that cannot be read is never rewritten, fails the column, and keeps the old key; a process left on the old key does too', async (t) => {
  const w = await world(t, { rows: 6 });
  setLogSink(() => {});
  t.after(restoreSink);
  const target = [...w.expected.keys()][2];
  const [{ access_token_enc: good }] = await w.sql('SELECT access_token_enc FROM ig_accounts WHERE ig_user_id = $1', [target]);
  const parts = good.split('.');
  const tampered = [...parts.slice(0, -1), `${parts.at(-1).slice(0, -2)}${parts.at(-1).endsWith('AA') ? 'BB' : 'AA'}`].join('.');
  await w.sql('UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = $2', [tampered, target]);

  const rotation = createSecretRotation(w.ctx(), { batch: 50 });
  await rotation.start();
  for (let i = 0; i < 100; i++) {
    const r = await rotation.step();
    if (!r.table) break;
  }
  const ig = (await rotation.progress()).columns.find((c) => c.table === 'ig_accounts');
  assert.equal(ig.status, 'failed');
  assert.equal((await w.sql('SELECT access_token_enc FROM ig_accounts WHERE ig_user_id = $1', [target]))[0].access_token_enc, tampered, 'left exactly as it was');
  const verdict = await rotation.retirable();
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.remaining, [{ table: 'ig_accounts', column: 'access_token_enc', count: 1 }]);
  assert.ok(w.counted.some((c) => c.labels.result === 'failed'));

  // The operator restores the value; start() again opens a fresh pass for the failed column, and it finishes.
  await w.sql('UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = $2', [good, target]);
  await rotation.start();
  await runToEnd(rotation);
  assert.equal((await rotation.retirable()).ok, true);

  // A process still on the old key writes after the column was done: the old key is not retirable again until a pass.
  await w.sql('UPDATE gateway_keys SET key_secret_enc = $1 WHERE provider = $2', [w.oldV1.encrypt('late-write-secret'), 'cashfree']);
  const late = await rotation.retirable();
  assert.deepEqual([late.ok, late.remaining.map((r) => r.table)], [false, ['gateway_keys']]);
  await rotation.start();
  assert.equal((await rotation.progress()).columns.find((c) => c.table === 'gateway_keys').status, 'pending', 'walked again');
  await runToEnd(rotation);
  assert.equal((await rotation.retirable()).ok, true);
  assert.equal(w.onlyNew.decrypt((await w.gwValues()).get(`${w.one.id},cashfree`)), 'late-write-secret');
});

test('the job: runs steps within its budget, carries on as a new job, and the schedule queues one only while a column is open', async (t) => {
  const w = await world(t, { rows: 8 });
  setLogSink(() => {});
  t.after(restoreSink);
  const queued = [];
  const handlers = new Map();
  const queue = { work: (name, fn) => handlers.set(name, fn), every: async (name) => (queued.push(['every', name]), '1'), enqueue: async (name) => (queued.push(['enqueue', name]), '1') };
  const ctx = { db: w.db, platform: { secrets: w.current, metrics: { inc: () => {} }, queue } };
  const schedule = secretRotation.jobs(ctx);
  assert.equal(typeof handlers.get(REWRAP_JOB), 'function');
  await schedule();
  assert.deepEqual(queued, [], 'nothing to do before a rotation is started');

  const rotation = createSecretRotation(ctx, { batch: 2, budgetMs: 0 });
  await rotation.start();
  queued.length = 0;
  await schedule();
  assert.deepEqual(queued, [['every', REWRAP_JOB]]);
  queued.length = 0;
  const first = await rotation.run();
  assert.equal(first.finished, false);
  assert.deepEqual(queued, [['enqueue', REWRAP_JOB]], 'out of budget: it carries on as a new job');
  // The registered handler finishes the work.
  for (let i = 0; i < 50 && !(await rotation.progress()).finished; i++) await handlers.get(REWRAP_JOB)();
  assert.equal((await rotation.progress()).finished, true);
  queued.length = 0;
  await schedule();
  assert.deepEqual(queued, []);
  // Without a current key there is nothing to rotate to, and it says so without a value.
  await assert.rejects(createSecretRotation({ db: w.db, platform: { secrets: createSecrets({}) } }).start(), /DATA_KEY is not set/);
});
