// The Maestro flows in apps/owner/.maestro (PRD 10.2 to 10.4, run by android-e2e in .github/workflows/apps.yml).
// No emulator runs here. What can be proved without one is proved: every flow parses, every element it touches is a
// testID the app really renders, every value it uses is one the job's server hands it, and the server half of every
// flow (the world support/server.mjs starts, and each runScript file, run as Maestro runs it) works against the real
// server and simulators. That the screens behave on a device is for the emulator job to prove.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYamlDocs } from './yaml-lite.js';
import { runScript } from './maestro-shim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAESTRO = path.join(ROOT, 'apps/owner/.maestro');
const SUPPORT = path.join(MAESTRO, 'support');
const read = (file) => fs.readFileSync(file, 'utf8');
const { flowEnv, SELLERS, BUSINESSES, ORDERS } = await import(pathToFileURL(path.join(SUPPORT, 'world.mjs')).href);

// ---- what the app renders ----

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.jsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateRegex = (template) => template.split(/\$\{[^}]*\}/).map(escape).join('.+');

/** Every testID in the app and its packages: literals, templates (`order-${id}`), and templates that extend a parent's id. */
function appTestIds() {
  const literals = new Set();
  const templates = [];
  const suffixes = [];
  const words = new Set();
  const files = ['apps/owner/src', 'packages/ui/src', 'packages/app-core/src'].flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
  for (const file of files) {
    for (const line of read(file).split('\n')) {
      for (const match of line.matchAll(/(["'])([A-Za-z][\w.-]{1,60})\1/g)) words.add(match[2]);
      if (!/testID/i.test(line)) continue;
      for (const match of line.matchAll(/testID\s*[=:]\s*\{?\s*(["'])([^"'\s]+)\1/gi)) literals.add(match[2]);
      for (const match of line.matchAll(/`([^`]*)`/g)) {
        const text = match[1];
        if (!text.includes('${')) continue;
        if (/^\$\{[^}]*\}/.test(text)) {
          const rest = text.replace(/^\$\{[^}]*\}/, '');
          // `${testID}-${option.value}`: what follows the parent's id is a value, so it must be a value the app has.
          suffixes.push({ pattern: new RegExp(`^${templateRegex(rest)}$`), valueOnly: !/[A-Za-z0-9]/.test(rest.replace(/\$\{[^}]*\}/g, '')) });
        } else templates.push(new RegExp(`^${templateRegex(text)}$`));
      }
    }
  }
  return { literals, templates, suffixes, words };
}

const ids = appTestIds();
/** True when the app renders an element whose testID is `id`. */
function rendered(id) {
  if (ids.literals.has(id) || ids.templates.some((pattern) => pattern.test(id))) return true;
  for (const literal of ids.literals) {
    if (!id.startsWith(literal)) continue;
    const rest = id.slice(literal.length);
    if (ids.suffixes.some(({ pattern, valueOnly }) => pattern.test(rest) && (!valueOnly || ids.words.has(rest.replace(/^-/, ''))))) return true;
  }
  return false;
}

// ---- the flows ----

const flowFiles = (dir) => fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => path.join(dir, name));
const TOP = flowFiles(MAESTRO);
const SHARED = flowFiles(path.join(MAESTRO, 'common'));

function parseFlow(file) {
  const [header, commands] = parseYamlDocs(read(file));
  assert.ok(header && Array.isArray(commands), `${path.relative(ROOT, file)} is not a header and a list of commands`);
  return { file, header, commands };
}

/** Every command in a flow, conditional and repeated blocks included. */
function* commandsOf(list) {
  for (const command of list) {
    yield command;
    const body = typeof command === 'object' ? Object.values(command)[0] : null;
    if (body && Array.isArray(body.commands)) yield* commandsOf(body.commands);
  }
}

/** Every selector id in a command, and every ${...} it uses. */
function selectorIds(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => selectorIds(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'id' && typeof v === 'string') out.push(v);
      else if (key !== 'env' && key !== 'when') selectorIds(v, out);
      else if (key === 'when') selectorIds(v, out);
    }
  }
  return out;
}
const variablesIn = (text) => [...String(text).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());

/** A concrete id for a selector: values put in, and regex wildcards made a plain part. */
const samples = (id) => id.split('|').map((alt) => alt.replace(/\$\{[^}]+\}/g, '7').replace(/\.\*/g, '7'));

const SAMPLE_ENV = flowEnv(
  { businesses: { a: { id: 1 }, b: { id: 2 }, c: { id: 3 } }, orders: { a: { id: 1, number: ORDERS.a.number }, b: { id: 2, number: ORDERS.b.number } } },
  { apiUrl: 'http://127.0.0.1:3000', whatsappUrl: 'http://127.0.0.1:9102', appHost: '10.0.2.2' },
);

describe('the flows, read', () => {
  const top = TOP.map(parseFlow);
  const shared = SHARED.map(parseFlow);

  test('I-01: there is a flow for each journey the release needs, at the top of .maestro where Maestro runs them', () => {
    const names = top.map((flow) => path.basename(flow.file));
    for (const name of ['sign-in.yaml', 'switch-business.yaml', 'automation.yaml', 'cod-order.yaml', 'payment-key.yaml', 'devices.yaml']) assert.ok(names.includes(name), `${name} is missing`);
    for (const flow of [...top, ...shared]) {
      assert.equal(flow.header.appId, '${APP_ID}', `${path.basename(flow.file)}: the app id comes from the job`);
      assert.ok(flow.header.name, `${path.basename(flow.file)} has no name`);
    }
    // Shared steps are never named for a requirement: the gate counts a flow by its name.
    for (const flow of shared) assert.doesNotMatch(flow.header.name, /^[A-Z]{1,3}-\d+/);
  });

  test('every element a flow touches is a testID the app renders', () => {
    const missing = [];
    for (const flow of [...top, ...shared]) {
      for (const command of commandsOf(flow.commands)) {
        for (const id of selectorIds(command)) {
          for (const sample of samples(id)) if (!rendered(sample)) missing.push(`${path.basename(flow.file)}: ${id}`);
        }
      }
    }
    assert.deepEqual(missing, []);
    // And the check would see a typo.
    assert.equal(rendered('sign-in-whatsap'), false);
    assert.equal(rendered('switcher-busines-7'), false);
  });

  test('every file a flow runs exists, and a feature opened from More is one that is in More', () => {
    for (const flow of [...top, ...shared]) {
      for (const command of commandsOf(flow.commands)) {
        const [name, body] = typeof command === 'object' ? Object.entries(command)[0] : [command, null];
        if (name === 'runScript' || (name === 'runFlow' && body?.file)) {
          const file = path.resolve(path.dirname(flow.file), body.file);
          assert.ok(fs.existsSync(file), `${path.basename(flow.file)} runs ${body.file}, which does not exist`);
        }
        if (name === 'runFlow' && body?.file === 'common/open-more.yaml') {
          const index = read(path.join(ROOT, 'apps/owner/src/features', body.env.FEATURE, 'index.js'));
          assert.match(index, /\bnav:\s*\{/, `${body.env.FEATURE} has no menu entry`);
          assert.doesNotMatch(index, /primary:\s*true/, `${body.env.FEATURE} is a tab, not in More`);
        }
      }
    }
  });

  test('every value a flow uses is one the job hands it, or one its caller passes', () => {
    const global = new Set(['APP_ID', ...Object.keys(SAMPLE_ENV)]);
    const passed = new Map();
    for (const flow of top) {
      for (const command of commandsOf(flow.commands)) {
        const body = typeof command === 'object' ? Object.values(command)[0] : null;
        if (body?.file && body.env && /^common\//.test(body.file)) passed.set(body.file, new Set([...(passed.get(body.file) ?? []), ...Object.keys(body.env)]));
      }
      for (const name of variablesIn(read(flow.file))) if (!name.startsWith('output.')) assert.ok(global.has(name), `${path.basename(flow.file)} uses \${${name}}, which nothing sets`);
    }
    for (const flow of shared) {
      const own = passed.get(`common/${path.basename(flow.file)}`) ?? new Set();
      for (const name of variablesIn(read(flow.file))) if (!name.startsWith('output.')) assert.ok(global.has(name) || own.has(name), `${path.basename(flow.file)} uses \${${name}}, which no caller passes`);
    }
  });

  test('the flows type only invented values: no real key, no business name from the PRD', () => {
    for (const flow of [...top, ...shared]) {
      const text = read(flow.file);
      assert.doesNotMatch(text, /rzp_(?:live|test)_[A-Za-z0-9]{10,}/, 'a key that could be real');
      assert.doesNotMatch(text, /mehta|plant\s*store/i);
    }
  });
});

// ---- the server half of every flow, against the job's own server ----

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

describe('the flows, rehearsed against the job server (support/server.mjs)', { timeout: 600_000 }, () => {
  let world;
  let env;
  const script = (name, extra) => runScript(path.join(SUPPORT, name), { ...env, ...extra });
  const onHost = (headers = {}) => ({ 'content-type': 'application/json', 'x-forwarded-host': env.SIGN_IN_HOST, ...headers });
  const api = async (pathname, { method = 'GET', token, body, headers } = {}) => {
    const res = await fetch(`${env.API_URL}/api/v1${pathname}`, { method, headers: onHost({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  /** The owner app's sign-in, with the code read by the flows' own script. */
  async function appSignIn(phone, name = 'Emulator') {
    const started = await api('/auth/start', { method: 'POST', body: { phone } });
    assert.equal(started.status, 202);
    const { code } = script('code.js', { PHONE: phone });
    const device = { id: crypto.randomBytes(16).toString('hex'), name, platform: 'android', app: 'owner', appVersion: '1.0.0' };
    const verified = await api('/auth/verify', { method: 'POST', body: { phone, code, transport: 'bearer', device } });
    assert.equal(verified.status, 201, verified.text);
    return verified.body;
  }

  // Started the way the job starts it, as its own process: the scripts' calls block, as Maestro's do, so the
  // simulators they call must not share this test's event loop. The IPC channel stops it when the test ends.
  before(async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-flows-env-')), 'flows.env');
    const child = spawn(process.execPath, [path.join(SUPPORT, 'server.mjs'), '--out', out], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'development', PORT: String(await freePort()), APP_HOST: 'localhost', SIM_BASE_PORT: '0' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    world = { child, exited, out };
    await Promise.race([
      new Promise((resolve) => child.once('message', resolve)),
      exited.then((code) => Promise.reject(new Error(`server.mjs exited with ${code}: ${stderr.slice(-800)}`))),
    ]);
    env = Object.fromEntries(read(out).trim().split(/\r?\n/).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  });
  after(async () => {
    if (!world) return;
    if (world.child.connected) world.child.disconnect();
    await Promise.race([world.exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    if (world.child.exitCode === null) world.child.kill();
    fs.rmSync(path.dirname(world.out), { recursive: true, force: true });
  });

  test('the server refuses to seed or start for production, or against a real database', async () => {
    const { startFlowServer } = await import(pathToFileURL(path.join(SUPPORT, 'server.mjs')).href);
    await assert.rejects(startFlowServer({ env: { NODE_ENV: 'production' } }), /never runs in production/);
    await assert.rejects(startFlowServer({ env: { DATABASE_URL: 'postgres://x' } }), /built-in database/);
  });

  test('what the flows are told is ids, invented numbers, names and local addresses only', () => {
    assert.deepEqual(Object.keys(env).sort(), Object.keys(SAMPLE_ENV).sort());
    for (const [name, value] of Object.entries(env)) {
      if (/_URL$/.test(name)) assert.match(value, /^http:\/\/127\.0\.0\.1:\d+$/, name);
      if (/^PHONE_/.test(name)) assert.match(value, /^90000001\d\d$/, name);
    }
  });

  test('P-11: a seller signs in with the WhatsApp code Bhava sent, read from the simulator the way the flow reads it', async () => {
    const session = await appSignIn(SELLERS.signIn.phone);
    assert.equal(session.business.name, BUSINESSES.a.name);
    assert.ok(session.accessToken && session.refreshToken);
    assert.throws(() => script('code.js', { PHONE: '9000000999' }), /No code was sent/);
  });

  test('P-10: the switcher lists exactly the two businesses, and each shows only its own order', async () => {
    const session = await appSignIn(SELLERS.switcher.phone);
    assert.deepEqual(session.businesses.map((b) => b.name).sort(), [BUSINESSES.a.name, BUSINESSES.b.name].sort());
    for (const [key, other] of [['a', 'b'], ['b', 'a']]) {
      const list = await api('/orders', { token: session.accessToken, headers: { 'x-tenant-id': env[`BUSINESS_${key.toUpperCase()}_ID`] } });
      assert.equal(list.status, 200, list.text);
      const numbers = list.body.items.map((order) => order.orderNumber);
      assert.ok(numbers.includes(ORDERS[key].number), `business ${key} does not list its order`);
      assert.ok(!numbers.includes(ORDERS[other].number), `business ${key} lists ${other}'s order`);
    }
  });

  test('an automation built the way the app builds one (a DM keyword reply) is accepted and listed', async () => {
    const form = await import(pathToFileURL(path.join(ROOT, 'apps/owner/src/features/automations/form.js')).href);
    const base = form.newForm();
    const values = { ...base, ...form.changeTrigger(base, 'dm_keyword'), name: 'E2E price reply', keywordDraft: 'price' };
    values.variants = values.variants.map((variant) => ({ ...variant, body: 'Thanks for asking. Here is the price list.' }));
    const { body, errors } = form.formToAutomation(values);
    assert.equal(errors, undefined);
    const session = await appSignIn(SELLERS.automation.phone);
    const created = await api('/automations', { method: 'POST', token: session.accessToken, body });
    assert.equal(created.status, 201, created.text);
    const list = await api('/automations', { token: session.accessToken });
    assert.ok(list.body.items.some((row) => row.name === 'E2E price reply'));
  });

  test('P-18: the order is a cash on delivery order to confirm; once the app confirms it, the console script sees packed', async () => {
    const rules = await import(pathToFileURL(path.join(ROOT, 'apps/owner/src/features/orders/kit/rules.js')).href);
    const session = await appSignIn(SELLERS.orders.phone);
    const order = await api(`/orders/${env.ORDER_A_ID}`, { token: session.accessToken });
    assert.equal(rules.codToConfirm(order.body), true, JSON.stringify(order.body).slice(0, 300));
    const confirm = rules.quickAction(order.body);
    const done = await api(`/orders/${env.ORDER_A_ID}/advance`, { method: 'POST', token: session.accessToken, body: rules.actionBody(confirm) });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(script('console-order.js', { PHONE: SELLERS.orderConsole.phone, ORDER_ID: env.ORDER_A_ID, EXPECT: 'packed' }), { consoleStatus: 'packed' });
    // A seller of another business, reading the same order id the way the console does, gets nothing.
    assert.throws(() => script('console-order.js', { PHONE: SELLERS.other.phone, ORDER_ID: env.ORDER_A_ID, EXPECT: 'packed' }), /answered 404/);
  });

  test('P-17: a key change on a refreshed session needs a fresh code; the code the flow reads lets it through, and the secret never comes back', async () => {
    const forms = await import(pathToFileURL(path.join(ROOT, 'apps/owner/src/features/orders/kit/forms.js')).href);
    const signedIn = await appSignIn(SELLERS.payments.phone);
    const refreshed = await api('/auth/refresh', { method: 'POST', body: { refreshToken: signedIn.refreshToken } });
    assert.equal(refreshed.status, 201, refreshed.text);
    const token = refreshed.body.accessToken;
    const { body, problems } = forms.razorpayKeysBody({ razorpayKeyId: 'rzp_test_e2eflow', razorpayKeySecret: 'flow-secret-not-real' });
    assert.deepEqual(problems ?? {}, {});
    const refused = await api('/settings/payment', { method: 'PATCH', token, body });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error?.code ?? refused.body.code, 'reauth_required');
    assert.equal((await api('/auth/reauth/start', { method: 'POST', token })).status, 202);
    const { code } = script('code.js', { PHONE: SELLERS.payments.phone });
    assert.equal((await api('/auth/reauth/verify', { method: 'POST', token, body: { code } })).status, 200);
    const saved = await api('/settings/payment', { method: 'PATCH', token, body });
    assert.equal(saved.status, 200, saved.text);
    assert.doesNotMatch(saved.text, /flow-secret-not-real/);
    const account = await api('/payment-account', { token });
    assert.equal(account.body.mode, 'own');
    assert.equal(account.body.ownConnection, 'keys');
    assert.doesNotMatch(account.text, /flow-secret-not-real/);
  });

  test('P-08: the second phone the flow makes is listed, and once revoked its token is refused', async () => {
    const phone = await appSignIn(SELLERS.devices.phone);
    // The emulator's code was used, so a code for the second phone goes out at once: no resend wait applies.
    const pixel = script('api-device.js', { ACTION: 'signIn', PHONE: SELLERS.devices.phone, NAME: 'Pixel 8' });
    const listed = await api('/auth/devices', { token: phone.accessToken });
    const row = listed.body.devices.find((device) => String(device.id) === pixel.deviceId);
    assert.equal(row?.name, 'Pixel 8');
    assert.throws(() => script('api-device.js', { ACTION: 'expectSignedOut', TOKEN: pixel.deviceToken }), /still signed in/);
    assert.equal((await api(`/auth/devices/${pixel.deviceId}`, { method: 'DELETE', token: phone.accessToken })).status, 204);
    assert.deepEqual(script('api-device.js', { ACTION: 'expectSignedOut', TOKEN: pixel.deviceToken }), { signedOut: 'yes' });
    // The emulator's own session still works until it revokes itself.
    assert.equal((await api('/auth/devices', { token: phone.accessToken })).status, 200);
  });
});
