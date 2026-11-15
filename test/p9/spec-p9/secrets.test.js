// F-64 to F-67 (PRD 5.15): the secrets store. Reading the columns directly, one business's token revoked, the master key
// rotated under load, and an error that holds a request address. Attack cases: every secret column read straight from the
// database and every other table searched; a value moved to another record; a retired key; every part of a stored value
// altered; rotation under load, stopped and resumed, with a damaged row, and with a straggler written under the old key.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecrets, describeStored } from '../../../src/platform/secrets.js';
import { SECRET_COLUMNS, REWRAP_STATUSES, RewrapProgress, oldKeysRetirable, redactUrl } from '../../../src/contracts/secrets.js';
import { createSecretRotation } from '../../../src/modules/secret-rotation/index.js';
import { createInstagram } from '../../../src/instagram.js';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { log, reportError, setLogSink } from '../../../src/platform/log.js';
import { TEST_DATA_KEY, startApp } from '../../helpers.js';
import { assertNoneOf, connect, echoingProvider, key, pause, plain, secretsWorld, whereFound } from './support.js';

const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});

const flip = (segment) => `${segment[0] === "A" ? "B" : "A"}${segment.slice(1)}`;
const defaultSink = (line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
function captureLog() {
  const lines = [];
  setLogSink((line) => lines.push(line));
  return { text: () => lines.join('\n'), restore: () => setLogSink(defaultSink) };
}

// ---- F-64 ----------------------------------------------------------------------------------------------------------------

test('F-64: reading every secret column straight from the database shows ciphertext only, and the plain value is in no table', async () => {
  const w = await secretsWorld({ format: 'v2' });
  closers.push(w.close);
  const a = await w.make('alpha');
  const b = await w.make('beta');
  const TOKEN_A = 'IGQVJ-alpha-token-0001-xyz'; // secret-scan:allow
  const TOKEN_B = 'IGQVJ-beta-token-0002-xyz'; // secret-scan:allow
  const GATEWAY = 'razorpay-secret-alpha-0003';
  await connect(w, a, 'ig-alpha-1', TOKEN_A);
  await connect(w, b, 'ig-beta-1', TOKEN_B);
  await a.repos.gatewayKeys.save('razorpay', { keyId: 'rzp_live_alpha1234', keySecret: GATEWAY }, 'owner');

  const plaintexts = [TOKEN_A, TOKEN_B, GATEWAY];
  const seen = [];
  for (const col of SECRET_COLUMNS) {
    const rows = await w.q(`SELECT ${col.column} AS v FROM ${col.table}`);
    for (const { v } of rows) {
      if (v === null || v === '') continue;
      seen.push(`${col.table}.${col.column}`);
      assert.ok(describeStored(v), `${col.table}.${col.column} holds an encrypted value`);
      assert.equal(describeStored(v).version, 'v2', `${col.table}.${col.column} is in the envelope form`);
      assertNoneOf(`${col.table}.${col.column}`, v, [...plaintexts, w.dataKey]);
    }
  }
  assert.ok(seen.includes('ig_accounts.access_token_enc') && seen.includes('gateway_keys.key_secret_enc'), 'the columns written were read back');
  for (const needle of [...plaintexts, w.dataKey]) assert.deepEqual(await whereFound(w.q, needle), [], 'no table holds a secret in the clear, or the master key');
  const [{ c }] = await w.q(`SELECT count(*)::int AS c FROM audit_log WHERE details::text LIKE '%razorpay-secret%'`);
  assert.equal(c, 0, 'the audit row of a key change holds no secret');
});

test('F-64: a value is its own: two stores of the same text differ, and each has its own wrapped data key', async () => {
  const w = await secretsWorld({ format: 'v2' });
  closers.push(w.close);
  const a = await w.make('one');
  const b = await w.make('two');
  await connect(w, a, 'ig-1', 'same-token-text-123');
  await connect(w, b, 'ig-2', 'same-token-text-123');
  const rows = await w.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE access_token_enc <> '' ORDER BY ig_user_id`);
  assert.equal(rows.length, 2);
  const [x, y] = rows.map((r) => r.v.split('.'));
  assert.notEqual(x[4], y[4], 'the wrapped data keys differ');
  assert.notEqual(x[7], y[7], 'the ciphertexts differ');
  assert.notEqual(x[5], y[5], 'the ivs differ');
});

test('F-64: a data key cannot be used for another record: values spliced together, or moved to another row, never open', async () => {
  const secrets = createSecrets({ dataKey: key(), secretsFormat: 'v2' });
  const a = secrets.encrypt('alpha-secret').split('.');
  const b = secrets.encrypt('beta-secret').split('.');
  assert.throws(() => secrets.decrypt([...a.slice(0, 5), ...b.slice(5)].join('.')), 'A wrapped key with B ciphertext');
  assert.throws(() => secrets.decrypt([...b.slice(0, 5), ...a.slice(5)].join('.')), 'B wrapped key with A ciphertext');
  assert.throws(() => secrets.decrypt([...a.slice(0, 2), ...b.slice(2, 5), ...a.slice(5)].join('.')), 'a swapped wrapped key');

  // Moved whole to another business's row: the other business must not end up holding the first one's token.
  const w = await secretsWorld({ format: 'v2' });
  closers.push(w.close);
  const one = await w.make('one');
  const two = await w.make('two');
  await connect(w, one, 'ig-one', 'token-of-business-one');
  await connect(w, two, 'ig-two', 'token-of-business-two');
  const [{ v }] = await w.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-one'`);
  await w.q(`UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = 'ig-two'`, [v]);
  const seenByTwo = await two.repos.igAccounts.get('ig-two');
  assert.notEqual(seenByTwo?.token, 'token-of-business-one', 'a value copied from another record is not accepted');
});

test('F-64: a retired key, a tampered part, a short value and a made-up one are all refused, and the refusal holds no key or value', async () => {
  const k1 = key();
  const k2 = key();
  const old = createSecrets({ dataKey: k1, secretsFormat: 'v2' });
  const stored = old.encrypt('very-private-token-777');
  const now = createSecrets({ dataKey: k2, secretsFormat: 'v2' });
  const attempt = (fn) => {
    try {
      return { value: fn() };
    } catch (e) {
      return { error: e };
    }
  };
  const clean = (res, label) => {
    assert.ok(res.error, `${label} is refused`);
    assertNoneOf(`${label} error`, `${res.error.message}${res.error.stack ?? ''}`, ['very-private-token-777', k1, k2]);
  };
  clean(attempt(() => now.decrypt(stored)), 'a retired key');
  const parts = stored.split('.');
  for (let i = 2; i < parts.length; i++) {
    const changed = parts.map((p, at) => (at === i ? flip(p) : p)).join('.');
    clean(attempt(() => old.decrypt(changed)), `part ${i} altered`);
  }
  clean(attempt(() => old.decrypt(parts.slice(0, 7).join('.'))), 'a value with a part missing');
  clean(attempt(() => old.decrypt(`${stored}.extra`)), 'a value with a part added');
  clean(attempt(() => old.decrypt(`v3.${parts.slice(1).join('.')}`)), 'an unknown version');
  clean(attempt(() => old.decrypt('')), 'an empty value');
  for (const bad of [null, undefined, 42]) assert.ok(attempt(() => old.decrypt(bad)).error || attempt(() => old.decrypt(bad)).value !== 'very-private-token-777', 'junk never gives the secret');
  const v1 = createSecrets({ dataKey: k1 });
  const v1Stored = v1.encrypt('very-private-token-777');
  const v1Parts = v1Stored.split('.');
  for (let i = 2; i < v1Parts.length; i++) clean(attempt(() => v1.decrypt(v1Parts.map((p, at) => (at === i ? flip(p) : p)).join('.'))), `v1 part ${i} altered`);
});

test('F-64: a damaged token in the database gives a business no token, not an error page or another value, and the log holds no ciphertext', async () => {
  const w = await secretsWorld({ format: 'v2' });
  closers.push(w.close);
  const shop = await w.make('damaged');
  await connect(w, shop, 'ig-damaged', 'token-to-be-damaged-1');
  const [{ v }] = await w.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-damaged'`);
  const parts = v.split('.');
  const logs = captureLog();
  try {
    for (const damaged of [parts.map((p, i) => (i === 7 ? flip(p) : p)).join('.'), `${parts.slice(0, 4).join('.')}.x`, 'v2.short']) {
      await w.q(`UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = 'ig-damaged'`, [damaged]).catch(() => {});
      const account = await shop.repos.igAccounts.get('ig-damaged');
      assert.ok(!account || account.token === '', 'no token comes back');
    }
  } finally {
    logs.restore();
  }
  assertNoneOf('the log', logs.text(), [parts[4], parts[7], 'token-to-be-damaged-1']);
});

// ---- F-65 ----------------------------------------------------------------------------------------------------------------

test('F-65: when A\'s token is revoked only A is affected: B keeps its token, its keys and its stored bytes', async () => {
  const w = await secretsWorld({ format: 'v2' });
  closers.push(w.close);
  const a = await w.make('revoked');
  const b = await w.make('untouched');
  await connect(w, a, 'ig-a', 'token-a-live');
  await connect(w, b, 'ig-b', 'token-b-live');
  await a.repos.gatewayKeys.save('razorpay', { keyId: 'rzp_live_aaaa1111', keySecret: 'gateway-a' }, 'owner');
  await b.repos.gatewayKeys.save('razorpay', { keyId: 'rzp_live_bbbb2222', keySecret: 'gateway-b' }, 'owner');
  const before = await w.q(`SELECT ig_user_id, access_token_enc, status FROM ig_accounts ORDER BY 1`);
  const bBefore = before.find((r) => r.ig_user_id === 'ig-b');

  await a.repos.igAccounts.loseToken('ig-a', 'token.rejected');

  const accountA = await a.repos.igAccounts.get('ig-a');
  assert.ok(!accountA || accountA.token === '', 'A no longer has a token to send with');
  const accountB = await b.repos.igAccounts.get('ig-b');
  assert.equal(accountB.token, 'token-b-live', 'B still sends');
  const after = await w.q(`SELECT ig_user_id, access_token_enc, status FROM ig_accounts ORDER BY 1`);
  assert.deepEqual(after.find((r) => r.ig_user_id === 'ig-b'), bBefore, 'B\'s row is byte for byte the same');
  assert.deepEqual((await b.repos.gatewayKeys.get('razorpay')).keySecret, 'gateway-b');
  assert.deepEqual((await a.repos.gatewayKeys.get('razorpay')).keySecret, 'gateway-a', 'a revoked Instagram token leaves A\'s other keys alone');
  assert.deepEqual(await w.q(`SELECT tenant_id FROM alerts WHERE kind LIKE 'token%' AND tenant_id <> $1`, [a.tenant.id]), [], 'no alert reaches another business');
});

test('F-65: one business\'s token cannot be read, replaced or revoked through another business\'s repos', async () => {
  const w = await secretsWorld({ format: 'v2' });
  closers.push(w.close);
  const a = await w.make('own');
  const b = await w.make('other');
  await connect(w, a, 'ig-own', 'token-own-1');
  await connect(w, b, 'ig-other', 'token-other-1');
  assert.ok(!(await b.repos.igAccounts.get('ig-own'))?.token, 'B cannot read A\'s token');
  await b.repos.igAccounts.setToken('ig-own', 'planted-by-b').catch(() => {});
  await b.repos.igAccounts.loseToken('ig-own', 'token.rejected').catch(() => {});
  assert.equal((await a.repos.igAccounts.get('ig-own')).token, 'token-own-1', 'A\'s token is as it was');
});

// ---- F-66 ----------------------------------------------------------------------------------------------------------------

/** An app whose running keys are NEW (with the test key as the old one), over data written under the old key in the v1 form. */
async function rotationWorld({ tenants = 20 } = {}) {
  const NEW = key();
  const app = await startApp({ overrides: { dataKey: NEW, dataKeyOld: TEST_DATA_KEY, secretsFormat: 'v2' } });
  closers.push(() => app.close());
  const ring = createSecrets({ dataKey: NEW, dataKeyOld: TEST_DATA_KEY, secretsFormat: 'v2' });
  const onlyNew = createSecrets({ dataKey: NEW, secretsFormat: 'v2' });
  const oldWriter = app.platform; // written with the old key, v1: what the data looked like before the rotation
  const planted = new Map();
  for (let i = 0; i < tenants; i++) {
    const tenant = await oldWriter.tenants.create({ slug: `rot-${i}`, name: `Rotating ${i}`, plan: 't3' });
    const repos = bindTenant(oldWriter, tenant);
    await oldWriter.tenants.linkIgAccount(tenant.id, `ig-rot-${i}`, `rot${i}`);
    await repos.igAccounts.setToken(`ig-rot-${i}`, `token-${i}-plain`);
    planted.set(`ig_accounts.access_token_enc:ig-rot-${i}`, `token-${i}-plain`);
    if (i % 2 === 0) {
      await repos.gatewayKeys.save('razorpay', { keyId: `rzp_live_key${String(i).padStart(4, '0')}`, keySecret: `gateway-${i}-plain` }, 'owner');
      planted.set(`gateway_keys.key_secret_enc:${tenant.id}`, `gateway-${i}-plain`);
    }
  }
  const q = (text, params) => (app.db.platform ?? app.db).query(text, params);
  const rotation = () => createSecretRotation(app.ctx);
  async function runToEnd(r = rotation(), limit = 400) {
    for (let i = 0; i < limit; i++) if ((await r.step()).finished) return i + 1;
    throw new Error(`the re-wrap did not finish in ${limit} steps`);
  }
  async function allSecrets() {
    const out = [];
    for (const col of SECRET_COLUMNS) {
      const rows = await q(`SELECT ${col.column} AS v FROM ${col.table}`);
      for (const { v } of rows) if (v) out.push({ ...col, v });
    }
    return out;
  }
  return { app, NEW, ring, onlyNew, planted, q, rotation, runToEnd, allSecrets };
}

test('F-66: the re-wrap moves every stored secret to the new master key and the v2 form; values read the same, ciphertext untouched, and the old key can go', async () => {
  const r = await rotationWorld();
  const before = await r.allSecrets();
  assert.ok(before.length >= 30 && before.every((s) => describeStored(s.v).version === 'v1'), 'the data starts in the v1 form');
  const oldIds = new Set(before.map((s) => describeStored(s.v).keyId));
  assert.equal(oldIds.has(r.ring.currentKeyId), false);
  const plainBefore = new Map(before.map((s) => [`${s.table}.${s.column}:${s.v}`, r.ring.decrypt(s.v)]));

  const rotation = r.rotation();
  await rotation.start();
  await r.runToEnd(rotation);
  const progress = RewrapProgress.parse(await rotation.progress());
  assert.equal(progress.finished, true);
  assert.equal(progress.keyId, r.ring.currentKeyId);
  assert.ok(progress.columns.every((c) => c.status === 'done' && REWRAP_STATUSES.includes(c.status)));

  const after = await r.allSecrets();
  assert.equal(after.length, before.length, 'nothing was dropped or added');
  for (const s of after) {
    const d = describeStored(s.v);
    assert.deepEqual([d.version, d.keyId], ['v2', r.ring.currentKeyId], `${s.table}.${s.column}`);
    assert.ok(r.onlyNew.decrypt(s.v), `${s.table}.${s.column} opens with the new key alone`);
  }
  assert.deepEqual([...plainBefore.values()].sort(), after.map((s) => r.onlyNew.decrypt(s.v)).sort(), 'every value reads the same');
  for (const [where, plain] of r.planted) {
    const [what, id] = where.split(':');
    const [table, column] = what.split('.');
    const pk = table === 'ig_accounts' ? 'ig_user_id' : 'tenant_id';
    const [row] = await r.q(`SELECT ${column} AS v FROM ${table} WHERE ${pk}::text = $1 LIMIT 1`, [id]);
    assert.equal(r.onlyNew.decrypt(row.v), plain, where);
  }

  const rows = (await r.q(`SELECT table_name, column_name, key_id, format, status FROM secret_rewraps`)).map((x) => ({ table: x.table_name, column: x.column_name, keyId: x.key_id, format: x.format, status: x.status }));
  assert.equal(oldKeysRetirable(rows, { keyId: r.ring.currentKeyId }), true, 'the old key may leave');
  assert.equal((await rotation.progress()).finished, true);
});

test('F-66: the re-wrap of a v2 value changes only its wrapped key; the value\'s own ciphertext is not rewritten', async () => {
  const r = await rotationWorld({ tenants: 4 });
  const oldSecrets = createSecrets({ dataKey: TEST_DATA_KEY, secretsFormat: 'v2' });
  // A value already in the v2 form under the old key.
  const tenant = await r.app.platform.tenants.create({ slug: 'v2-old', name: 'V2 old', plan: 't3' });
  await r.app.platform.tenants.linkIgAccount(tenant.id, 'ig-v2-old', 'v2old');
  const stored = oldSecrets.encrypt('v2-old-token');
  await r.q(`UPDATE ig_accounts SET access_token_enc = $1, status = 'active' WHERE ig_user_id = 'ig-v2-old'`, [stored]);
  await r.runToEnd();
  const [{ v }] = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-v2-old'`);
  assert.deepEqual(v.split('.').slice(5), stored.split('.').slice(5), 'the ciphertext is as it was');
  assert.equal(v.split('.')[1], r.ring.currentKeyId);
  assert.equal(r.onlyNew.decrypt(v), 'v2-old-token');
});

test('F-66: no downtime: reads never fail while the re-wrap runs, and writes made during it are under a readable key', async () => {
  const r = await rotationWorld({ tenants: 16 });
  const rotation = r.rotation();
  await rotation.start();
  const writer = createRepos(r.app.db, { secrets: r.ring });
  let stop = false;
  let reads = 0;
  const failures = [];
  const reader = (async () => {
    while (!stop) {
      for (const s of await r.allSecrets()) {
        try {
          r.ring.decrypt(s.v);
          reads++;
        } catch (e) {
          failures.push(`${s.table}.${s.column}: ${e.message}`);
        }
      }
      await pause(2);
    }
  })();
  let written = 0;
  const writes = (async () => {
    for (let i = 0; i < 6; i++) {
      const tenant = await writer.tenants.create({ slug: `late-${i}`, name: `Late ${i}`, plan: 't3' });
      await writer.tenants.linkIgAccount(tenant.id, `ig-late-${i}`, `late${i}`);
      await bindTenant(writer, tenant).igAccounts.setToken(`ig-late-${i}`, `late-token-${i}`);
      written++;
      await pause(3);
    }
  })();
  const steps = (async () => {
    for (let i = 0; i < 400; i++) {
      if ((await rotation.step()).finished) break;
      await pause(1);
    }
  })();
  await Promise.all([writes, steps]);
  stop = true;
  await reader;
  assert.deepEqual(failures, [], 'every value read while the job ran decrypted');
  assert.ok(reads > 0 && written === 6);
  const late = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id LIKE 'ig-late-%'`);
  for (const { v } of late) assert.ok(r.ring.decrypt(v).startsWith('late-token-'));
});

test('F-66: a re-wrap stopped halfway and picked up by another process carries on from where it stopped and counts each row once', async () => {
  const r = await rotationWorld({ tenants: 14 });
  const first = r.rotation();
  await first.start();
  for (let i = 0; i < 3; i++) await first.step();
  const midway = await first.progress();
  assert.equal(midway.finished, false);
  assert.ok(midway.columns.some((c) => c.status === 'done' || c.done > 0), 'some work was done');

  const second = r.rotation(); // a new process: nothing in memory
  const resumed = await second.progress();
  assert.deepEqual(resumed.columns.map((c) => [c.table, c.column, c.status, c.done]), midway.columns.map((c) => [c.table, c.column, c.status, c.done]), 'the place reached is stored, not kept in memory');
  await r.runToEnd(second);
  const done = await second.progress();
  assert.equal(done.finished, true);
  const rows = await r.q(`SELECT table_name, column_name, rows_done FROM secret_rewraps WHERE status = 'done'`);
  for (const { table_name: t, column_name: c, rows_done: n } of rows) {
    const [{ total }] = await r.q(`SELECT count(*)::int AS total FROM ${t} WHERE ${c} IS NOT NULL AND ${c} <> ''`);
    assert.ok(Number(n) <= total, `${t}.${c}: ${n} rows counted, ${total} rows exist: no row counted twice`);
  }
  assert.ok((await r.allSecrets()).every((s) => describeStored(s.v).keyId === r.ring.currentKeyId));
});

test('F-66: two workers stepping at once leave every value readable and under the new key', async () => {
  const r = await rotationWorld({ tenants: 12 });
  const a = r.rotation();
  const b = r.rotation();
  await a.start();
  await Promise.all([r.runToEnd(a), r.runToEnd(b)]);
  for (const s of await r.allSecrets()) {
    assert.equal(describeStored(s.v).keyId, r.ring.currentKeyId);
    assert.ok(r.onlyNew.decrypt(s.v));
  }
});

test('F-66: a damaged row does not make the job lose others or call itself done: the old key stays needed until it is mended', async () => {
  const r = await rotationWorld({ tenants: 6 });
  const [victim] = await r.q(`SELECT ig_user_id, access_token_enc AS v FROM ig_accounts WHERE ig_user_id LIKE 'ig-rot-%' ORDER BY 1 LIMIT 1`);
  const parts = victim.v.split('.');
  const damaged = `${parts.slice(0, 4).join('.')}.${flip(parts[4])}`;
  await r.q(`UPDATE ig_accounts SET access_token_enc = $1 WHERE ig_user_id = $2`, [damaged, victim.ig_user_id]);
  const rotation = r.rotation();
  await rotation.start();
  for (let i = 0; i < 60; i++) await rotation.step().catch(() => ({}));
  const [still] = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = $1`, [victim.ig_user_id]);
  assert.equal(still.v, damaged, 'the damaged value is left as it is, not blanked or replaced');
  const progress = await rotation.progress();
  assert.equal(progress.finished, false, 'the job does not say finished with a value it could not move');
  const rows = (await r.q(`SELECT table_name, column_name, key_id, format, status FROM secret_rewraps`)).map((x) => ({ table: x.table_name, column: x.column_name, keyId: x.key_id, format: x.format, status: x.status }));
  assert.equal(oldKeysRetirable(rows, { keyId: r.ring.currentKeyId }), false);
  const others = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id LIKE 'ig-rot-%' AND ig_user_id <> $1`, [victim.ig_user_id]);
  for (const { v } of others) assert.ok(r.ring.decrypt(v), 'every other value still opens');
});

test('F-66: a value written under the old key after the job passed it is found by the next run, and the old key is not called free before then', async () => {
  const r = await rotationWorld({ tenants: 5 });
  const rotation = r.rotation();
  await rotation.start();
  await r.runToEnd(rotation);
  const tenant = await r.app.platform.tenants.create({ slug: 'straggler', name: 'Straggler', plan: 't3' });
  await r.app.platform.tenants.linkIgAccount(tenant.id, 'ig-straggler', 'straggler');
  await bindTenant(r.app.platform, tenant).igAccounts.setToken('ig-straggler', 'written-by-a-stale-server'); // the test's old-key writer
  const stale = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-straggler'`);
  assert.notEqual(describeStored(stale[0].v).keyId, r.ring.currentKeyId, 'the straggler is under the old key');
  const mid = await rotation.progress();
  if (mid.finished) {
    // Finished is only true when nothing is left under an older key; a stale write must re-open the question on the next run.
    await rotation.start();
  } else {
    await rotation.start();
  }
  await r.runToEnd(rotation);
  const [{ v }] = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-straggler'`);
  assert.equal(describeStored(v).keyId, r.ring.currentKeyId, 'the next run moved it');
  assert.equal(r.onlyNew.decrypt(v), 'written-by-a-stale-server');
});

test('F-66: empty and missing secrets are left as they are, and a business with none is not given one', async () => {
  const r = await rotationWorld({ tenants: 3 });
  const tenant = await r.app.platform.tenants.create({ slug: 'no-secret', name: 'No secret', plan: 't3' });
  await r.app.platform.tenants.linkIgAccount(tenant.id, 'ig-no-token', 'notoken');
  const before = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-no-token'`);
  assert.ok(before[0].v === '' || before[0].v === null);
  await r.runToEnd();
  const after = await r.q(`SELECT access_token_enc AS v FROM ig_accounts WHERE ig_user_id = 'ig-no-token'`);
  assert.deepEqual(after, before);
});

test('F-66: the job, its progress and the counters carry no value, key or business', async () => {
  const r = await rotationWorld({ tenants: 4 });
  const logs = captureLog();
  let progress;
  try {
    const rotation = r.rotation();
    await rotation.start();
    await r.runToEnd(rotation);
    progress = await rotation.progress();
  } finally {
    logs.restore();
  }
  const body = JSON.stringify(progress) + logs.text();
  assertNoneOf('the re-wrap output', body, [r.NEW, TEST_DATA_KEY, ...[...r.planted.values()], 'rot-0', 'Rotating']);
  const metrics = await r.app.ctx.platform.metrics.render();
  assertNoneOf('/metrics', metrics, [r.NEW, TEST_DATA_KEY, ...[...r.planted.values()], 'rot-1']);
});

// ---- F-67 ----------------------------------------------------------------------------------------------------------------

test('F-67: an address in an error loses its token, login and credentials wherever it sits', () => {
  const TOKEN = 'EAAGm0PX4ZCpsBAKtokenvalue123'; // secret-scan:allow
  const cases = [
    `GET https://graph.instagram.com/v21.0/me?fields=id&access_token=${TOKEN} failed`,
    `request to https://graph.facebook.com/v21.0/123/messages?access_token=${TOKEN}&limit=5 failed: ECONNRESET`,
    `fetch failed: https://user:${TOKEN}@host.example/path`,
    `http://api.example/x?client_secret=${TOKEN}&code=${TOKEN}`,
    `Authorization: Bearer ${TOKEN}`,
    `Authorization: Basic ${TOKEN}`,
    `see https://a.example/?token=${TOKEN} and https://b.example/?key=${TOKEN}`,
    `POST https://api.example:8443/v1/pay?signature=${TOKEN}#frag`,
  ];
  for (const text of cases) assert.ok(!redactUrl(text).includes(TOKEN), `still shows the token: ${redactUrl(text)}`);
  assert.equal(redactUrl('plain words, no address'), 'plain words, no address');
  assert.equal(redactUrl(null), '');
});

test('F-67: an error that holds a request address is logged without the token, in the message, the stack and the reporter\'s copy', () => {
  const TOKEN = 'EAAGm0PX4ZCpsBAKerrortoken456'; // secret-scan:allow
  const logs = captureLog();
  const reported = [];
  try {
    const err = new Error(`GET https://graph.instagram.com/v21.0/me?access_token=${TOKEN} returned 401`);
    err.cause = new Error(`inner https://graph.instagram.com/x?access_token=${TOKEN}`);
    reportError(err, { msg: 'ig.call_failed' });
    log.error('ig.call_failed', { err });
    reported.push(logs.text());
  } finally {
    logs.restore();
  }
  assert.ok(reported[0].length > 0 && reported[0].includes('ig.call_failed'));
  assertNoneOf('the log', reported[0], [TOKEN]);
});

test('F-67: a provider that echoes the whole request in its error leaves the token out of what the caller can see and log', async () => {
  const TOKEN = 'EAAGm0PX4ZCpsBAKechoedtoken789'; // secret-scan:allow
  const provider = await echoingProvider();
  closers.push(provider.close);
  const ig = createInstagram({ graphBaseUrl: provider.url, igApiBaseUrl: provider.url, fbGraphBaseUrl: provider.url, dryRun: false });
  const logs = captureLog();
  let caught;
  try {
    caught = await ig.getAccount({ igUserId: 'ME', token: TOKEN }).then(() => null, (e) => e);
  } finally {
    logs.restore();
  }
  assert.ok(caught, 'the failing provider gives an error');
  const shown = `${caught.message}\n${caught.stack}\n${JSON.stringify(plain(caught))}\n${logs.text()}`;
  assertNoneOf('the error and the log', shown, [TOKEN]);
});

test('F-67: a webhook whose send fails with an address in the error leaves the token out of the log, the alerts and every table', async () => {
  const TOKEN = 'token-ME-echo-secret-1234567'; // secret-scan:allow
  const echoing = {
    calls: [],
    accounts: [],
    sendPrivateReplyButton: async () => { throw new Error(`POST https://graph.instagram.com/v21.0/ME/messages?access_token=${TOKEN} failed with 400`); },
    sendPrivateReply: async () => { throw new Error(`POST https://graph.instagram.com/v21.0/ME/messages?access_token=${TOKEN} failed with 400`); },
    sendMessage: async () => { throw new Error(`POST https://graph.instagram.com/v21.0/ME/messages?access_token=${TOKEN} failed with 400`); },
    replyToComment: async () => {},
    listMedia: async () => ({ data: [] }),
    getMedia: async (_a, id) => ({ id }),
    getAccount: async () => ({ username: 'shop', user_id: 'ME' }),
  };
  const app = await startApp({ ig: echoing });
  closers.push(() => app.close());
  const { products } = await (await import('../../helpers.js')).seedReel(app.repos);
  assert.ok(products.length > 0);
  await app.repos.igAccounts.setToken('ME', TOKEN);
  const logs = captureLog();
  try {
    const crypto = await import('node:crypto');
    const body = JSON.stringify({ entry: [{ id: 'ME', changes: [{ field: 'comments', value: { id: 'c-1', text: 'LINK', media: { id: (await import('../../helpers.js')).REEL_ID }, from: { id: 'shopper-1', username: 'a_shopper' } } }] }] });
    const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
    await fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
    await pause(300);
  } finally {
    logs.restore();
  }
  assertNoneOf('the log', logs.text(), [TOKEN]);
  const tables = await whereFound((text, params) => (app.db.platform ?? app.db).query(text, params), TOKEN);
  assert.deepEqual(tables, [], 'the token is stored in no table in the clear');
});
