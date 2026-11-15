// Where secrets come from, under attack (PRD 5.15, F-66, F-67; G-04, G-05): the secret manager slow, down, refusing our
// token, answering garbage or echoing the request; a refresh that fails keeps the last good values and alerts; a secret
// deleted at the manager never empties a running process; a missing required secret names the setting only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSecrets } from '../../../src/config.js';
import { SecretSourceError, createSecretSource } from '../../../src/platform/secret-source.js';
import { createSecretsManager } from '../../../tools/sim/secrets/index.mjs';

const TOKEN = 'manager-token-0123456789abcdef'; // secret-scan:allow (made-up fixture)
const NAMES = ['DATA_KEY', 'APP_SECRET', 'SESSION_SECRET'];
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p9-source-'));

async function world(t, secrets = { DATA_KEY: 'data-key-value-one', APP_SECRET: 'app-secret-value-one', SESSION_SECRET: 'session-secret-value-one' }) {
  const manager = createSecretsManager({ token: TOKEN, prefix: 'v1/bhava', secrets });
  await manager.start();
  t.after(() => manager.close());
  const dir = scratch();
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  const env = { SECRETS_DRIVER: 'http', SECRETS_URL: manager.url, SECRETS_PATH_PREFIX: 'v1/bhava', SECRETS_TOKEN_FILE: tokenFile, SECRETS_TIMEOUT_MS: '300' };
  return { manager, env, dir };
}

/** Every request the source makes, through the real fetch. */
const recording = (calls) => (url, init) => {
  calls.push({ url: String(url), headers: { ...init?.headers } });
  return globalThis.fetch(url, init);
};
const failure = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected the load to fail');
};
const clean = (err, ...values) => {
  const text = `${err.message}\n${err.stack}\n${JSON.stringify(err)}`;
  for (const value of values) assert.ok(!text.includes(value), 'no secret in the error');
};

test('the token travels in a header only, never in an address, and the values come back by name', async (t) => {
  const { env } = await world(t);
  const calls = [];
  const source = createSecretSource({ names: NAMES, env, fetch: recording(calls) });
  const loaded = await source.load();
  assert.deepEqual(loaded.values, { DATA_KEY: 'data-key-value-one', APP_SECRET: 'app-secret-value-one', SESSION_SECRET: 'session-secret-value-one' });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(!call.url.includes(TOKEN) && !/[?#]/.test(call.url), 'no token and no query in the address');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  }
  assert.ok(!JSON.stringify(source.state()).includes('value-one'));
  // The redactor knows every loaded value.
  const redact = source.redactor();
  assert.equal(redact('Shopify said: bad token app-secret-value-one'), 'Shopify said: bad token [redacted]');
});

test('slow, down, a refused token, garbage and an error that echoes the request: start is refused and nothing leaks', async (t) => {
  const { manager, env } = await world(t);
  const load = () => createSecretSource({ names: NAMES, env }).load();

  await manager.post('/echo', { on: true });
  const echoed = await failure(load());
  assert.ok(echoed instanceof SecretSourceError);
  assert.equal(echoed.code, 'unavailable');
  clean(echoed, TOKEN, 'value-one');
  assert.match(echoed.message, /answered 500/);
  await manager.post('/echo', { on: false });

  await manager.post('/garbage', { on: true });
  const garbage = await failure(load());
  assert.equal(garbage.code, 'invalid_answer');
  clean(garbage, TOKEN, 'value-one');
  await manager.post('/garbage', { on: false });

  await manager.post('/slow', { ms: 1000 });
  const slow = await failure(load());
  assert.equal(slow.code, 'unreachable');
  assert.ok(NAMES.includes(slow.setting));
  await manager.post('/slow', { ms: 0 });

  await manager.post('/outage', { on: true });
  assert.equal((await failure(load())).code, 'unavailable');
  await manager.post('/outage', { on: false });

  await manager.post('/token', { token: 'a-different-token-entirely' });
  const refused = await failure(load());
  assert.deepEqual([refused.code, refused.setting], ['unauthorized', 'SECRETS_TOKEN_FILE']);
  clean(refused, TOKEN);
  await manager.post('/token', { token: TOKEN });

  // A manager that is not there at all, and one that tries to send us elsewhere.
  const gone = await failure(createSecretSource({ names: NAMES, env: { ...env, SECRETS_URL: 'http://127.0.0.1:1' } }).load());
  assert.equal(gone.code, 'unreachable');
  const redirecting = await failure(createSecretSource({ names: NAMES, env, fetch: async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.example' } }) }).load());
  assert.equal(redirecting.code, 'unavailable');
  // A token file that cannot be read names the setting, not the path.
  const missing = await failure(createSecretSource({ names: NAMES, env: { ...env, SECRETS_TOKEN_FILE: path.join(scratch(), 'secret-place', 'token') } }).load());
  assert.equal(missing.setting, 'SECRETS_TOKEN_FILE');
  assert.ok(!missing.message.includes('secret-place'));
  // An address with a login or a query in it is refused before anything is sent.
  for (const url of [manager.url.replace('http://', `http://user:${TOKEN}@`), `${manager.url}?token=${TOKEN}`]) {
    const bad = await failure(createSecretSource({ names: NAMES, env: { ...env, SECRETS_URL: url } }).load());
    assert.equal(bad.setting, 'SECRETS_URL');
    clean(bad, TOKEN);
  }
  // In production the manager must be https, even on loopback.
  assert.equal((await failure(createSecretSource({ names: NAMES, env: { ...env, NODE_ENV: 'production' } }).load())).setting, 'SECRETS_URL');
});

test('a failed refresh keeps the last good values and alerts; a deleted secret keeps its value too; a change reaches by name', async (t) => {
  const { manager, env } = await world(t);
  const alerts = [];
  const source = createSecretSource({ names: NAMES, env, onAlert: (alert) => alerts.push(alert) });
  const first = await source.load();
  const changes = [];
  const onChange = (change) => changes.push(change);

  for (const fault of [['/outage', { on: true }], ['/token', { token: 'not-ours-any-more' }], ['/garbage', { on: true }], ['/echo', { on: true }]]) {
    await manager.post(...fault);
    const before = alerts.length;
    await source.refresh(onChange);
    assert.equal(alerts.length, before + 1, `alerted: ${fault[0]}`);
    assert.ok(!JSON.stringify(alerts).includes(TOKEN) && !JSON.stringify(alerts).includes('value-one'));
    await manager.post('/reset', {});
  }
  assert.deepEqual(alerts.map((a) => a.code), ['unavailable', 'unauthorized', 'invalid_answer', 'unavailable']);
  assert.equal(changes.length, 0, 'nothing changed: the last good values are in use');
  assert.equal(source.state().failures, 4);

  // The secret is deleted at the manager: the process keeps the last good value, and says which setting went.
  await manager.post('/delete', { name: 'SESSION_SECRET' });
  await source.refresh(onChange);
  assert.deepEqual(alerts.at(-1), { code: 'missing', setting: 'SESSION_SECRET' });
  assert.equal(changes.length, 0);
  assert.equal(source.redactor()('session-secret-value-one'), '[redacted]', 'still held');

  // A rotation arrives by name; a refresh while one is still running does not run beside it.
  await manager.post('/secrets', { name: 'SESSION_SECRET', value: 'session-secret-value-one' });
  await manager.post('/rotate', { name: 'APP_SECRET', value: 'app-secret-value-two' });
  await manager.post('/slow', { ms: 100 });
  await Promise.all([source.refresh(onChange), source.refresh(onChange), source.refresh(onChange)]);
  await manager.post('/slow', { ms: 0 });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].changed, ['APP_SECRET']);
  assert.equal(changes[0].values.APP_SECRET, 'app-secret-value-two');
  assert.equal(changes[0].values.DATA_KEY, first.values.DATA_KEY);
  // A broken alert handler never stops the refresh.
  const brittle = createSecretSource({ names: NAMES, env, onAlert: () => { throw new Error('pager down'); } });
  await brittle.load();
  await manager.post('/outage', { on: true });
  await brittle.refresh();
  assert.equal(brittle.state().lastError, 'unavailable');
});

test('a missing required secret refuses the start and names the setting only; a file that cannot be read names it too', async () => {
  const present = { DATA_KEY: 'kept-out-of-messages-1', SESSION_SECRET: 'kept-out-of-messages-2' }; // secret-scan:allow (made-up fixture)
  const source = { load: async () => ({ values: present, sources: { DATA_KEY: 'file', SESSION_SECRET: 'file' }, versions: {} }) };
  const err = await failure(loadSecrets({ deployEnv: 'production', secretSources: {} }, { env: {}, source }));
  assert.match(err.message, /APP_SECRET/);
  assert.match(err.message, /METRICS_TOKEN/);
  assert.ok(!err.message.includes('DATA_KEY') && !err.message.includes('kept-out-of-messages'), 'present ones are not named, and no value is');
  // Outside a production deploy the same config starts.
  const cfg = { secretSources: {} };
  await loadSecrets(cfg, { env: {}, source });
  assert.equal(cfg.dataKey, present.DATA_KEY);

  const dir = scratch();
  const unreadable = await failure(createSecretSource({ names: NAMES, env: { SECRETS_DRIVER: 'file', SECRETS_DIR: dir, APP_SECRET_FILE: path.join(dir, 'private-folder', 'x') } }).load());
  assert.deepEqual([unreadable.setting, unreadable.code], ['APP_SECRET', 'unreadable']);
  assert.ok(!unreadable.message.includes('private-folder'));
});
