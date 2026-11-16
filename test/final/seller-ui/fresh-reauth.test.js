// seller-ui-1: every route the contract marks `fresh` answers 403 reauth_required once the sign-in is older than
// FRESH_MINUTES. The console must then ask "Confirm it is you" and repeat the call, on every page, not only on the pages
// that remembered to opt in. These tests drive the console's own API client (console/src/lib/api) with the server's
// refusal and check that one re-auth sheet is asked for and the call is repeated, for every fresh route the console calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FRESH_ROUTES, routes } from '../../../src/contracts/api/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const consoleSrc = path.join(repoRoot, 'console/src');

// The console imports '@bhava/api-client' by package name; test this checkout's copy of it, wherever node_modules points.
const clientUrl = pathToFileURL(path.join(repoRoot, 'shared/api-client/index.js')).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === '@bhava/api-client') return { url: ${JSON.stringify(clientUrl)}, shortCircuit: true };
  return next(specifier, context);
}`)}`);

const { createApiClient } = await import(clientUrl);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const consoleFiles = walk(consoleSrc).filter((file) => /\.jsx?$/.test(file)).map((file) => ({ name: path.relative(consoleSrc, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));

/** Every fresh route some console screen calls, with the files that call it. */
const consoleFreshCalls = FRESH_ROUTES.map((id) => {
  const [group, name] = id.split('.');
  const call = new RegExp(`\\bapi\\.${group}\\.${name}\\(`);
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // a call in a doc comment is not a call
  return { id, files: consoleFiles.filter(({ text }) => call.test(code(text))).map(({ name: file }) => file) };
}).filter(({ files }) => files.length > 0);

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = () => jsonResponse({ error: 'Confirm it is you to continue.', code: 'reauth_required' }, 403);

const argsFor = (route) => {
  const args = route.path.includes(':') ? ['7'] : [];
  if (route.body) args.push({ sample: true });
  return args;
};

test('the shared client repeats a refused call once the re-auth hook says the session is fresh again', async () => {
  const answers = [refusal, () => jsonResponse({ ok: 1 })];
  const sent = [];
  const asked = [];
  const client = createApiClient({
    onReauthRequired: async (error) => { asked.push(error.code); return true; },
    fetch: async (url, options) => { sent.push([options.method, url, options.body]); return answers.shift()(); },
  });
  assert.deepEqual(await client.settings.updatePayment({ codEnabled: true }), { ok: 1 });
  assert.deepEqual(asked, ['reauth_required']);
  assert.equal(sent.length, 2, 'the same call is sent again');
  assert.deepEqual(sent[1], sent[0]);
});

test('the shared client lets the refusal through when the hook does not confirm, and never loops', async () => {
  // A hook that only notices (returns nothing) keeps the old meaning: the caller sees reauth_required.
  const quiet = createApiClient({ onReauthRequired: () => {}, fetch: async () => refusal() });
  assert.equal((await quiet.tags.update({}).catch((e) => e)).code, 'reauth_required');
  // Closing the sheet rejects: that rejection is what the caller gets, and nothing is sent again.
  let sends = 0;
  const closed = createApiClient({ onReauthRequired: () => Promise.reject(Object.assign(new Error('Cancelled'), { cancelled: true })), fetch: async () => { sends += 1; return refusal(); } });
  assert.equal((await closed.tags.update({}).catch((e) => e)).cancelled, true);
  assert.equal(sends, 1);
  // A server that still refuses after a re-auth is asked once, not forever.
  let asked = 0;
  const stubborn = createApiClient({ onReauthRequired: async () => { asked += 1; return true; }, fetch: async () => refusal() });
  assert.equal((await stubborn.tags.update({}).catch((e) => e)).code, 'reauth_required');
  assert.equal(asked, 1);
});

test('the console calls the fresh routes the finding names, so each is covered below', () => {
  const named = ['paymentAccount.startLinked', 'paymentAccount.connectUrl', 'paymentAccount.setMode', 'paymentAccount.disconnect', 'settings.updatePayment', 'shippingSettings.update',
    'whatsappAccount.connect', 'whatsappAccount.disconnect', 'shopify.connect', 'shopify.disconnect', 'apiKeys.create', 'apiKeys.revoke', 'tags.update'];
  const called = consoleFreshCalls.map(({ id }) => id);
  for (const id of named) {
    assert.equal(routes[id]?.fresh, true, `${id} is a fresh route`);
    assert.ok(called.includes(id), `a console screen calls ${id}`);
  }
});

test('every fresh route the console calls opens the one re-auth sheet on reauth_required, then repeats the call', async (t) => {
  const { api } = await import(pathToFileURL(path.join(consoleSrc, 'lib/api/index.js')).href);
  const gate = await import(pathToFileURL(path.join(consoleSrc, 'lib/fresh-gate.js')).href);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  let opened = 0;
  t.after(gate.setFreshOpener(async () => { opened += 1; }));

  for (const { id, files } of consoleFreshCalls) {
    const route = routes[id];
    const [group, name] = id.split('.');
    const sent = [];
    const answers = [refusal, () => (route.status === 204 ? new Response(null, { status: 204 }) : jsonResponse({ done: id }))];
    globalThis.fetch = async (url, options) => { sent.push([options.method, url]); return answers.shift()(); };
    opened = 0;
    const result = await api[group][name](...argsFor(route));
    assert.equal(opened, 1, `${id} (${files.join(', ')}): the re-auth sheet opens once`);
    assert.equal(sent.length, 2, `${id}: the call is repeated after the re-auth`);
    assert.deepEqual(sent[1], sent[0], `${id}: the same call`);
    assert.deepEqual(result, route.status === 204 ? null : { done: id }, `${id}: the screen gets the answer`);
  }
});

test('closing the sheet is a cancel the screens already ignore, and nothing is sent again', async (t) => {
  const { api } = await import(pathToFileURL(path.join(consoleSrc, 'lib/api/index.js')).href);
  const gate = await import(pathToFileURL(path.join(consoleSrc, 'lib/fresh-gate.js')).href);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  t.after(gate.setFreshOpener(() => Promise.reject(new gate.Cancelled())));
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return refusal(); };
  const error = await api.apiKeys.revoke('7').catch((e) => e);
  assert.equal(gate.isCancelled(error), true);
  assert.equal(sends, 1);
});

test('with no sheet mounted (signed out), the refusal reaches the caller unchanged', async (t) => {
  const { api } = await import(pathToFileURL(path.join(consoleSrc, 'lib/api/index.js')).href);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => refusal();
  assert.equal((await api.tags.update({}).catch((e) => e)).code, 'reauth_required');
});

test('closing the sheet shows no error: the shared form and action helpers, and every screen with its own handler, skip it', () => {
  const source = (name) => consoleFiles.find((file) => file.name === name)?.text ?? '';
  assert.match(source('lib/forms.js'), /if \(isCancelled\(error\)\) return false;/, 'form.run');
  assert.match(source('features/orders/shared/ui.jsx'), /if \(!isCancelled\(error\)\) setProblem/, 'useAction().run');
  // form.run and action.run are covered above; a call made straight from a mutation shows its error in the mutation's onError.
  for (const { id, files } of consoleFreshCalls) {
    const [group, name] = id.split('.');
    const fromMutation = new RegExp(`mutationFn:[^\\n]*\\bapi\\.${group}\\.${name}\\(`);
    for (const file of files) {
      const text = source(file);
      if (fromMutation.test(text)) assert.match(text, /isCancelled\(/, `${file} (${id}) shows its own errors, so it must skip a closed re-auth`);
    }
  }
});

test('the sheet is mounted once for the whole signed-in console, and the client is wired to it', () => {
  const source = (name) => consoleFiles.find((file) => file.name === name)?.text ?? '';
  assert.match(source('lib/api/index.js'), /onReauthRequired:/, 'the console client handles reauth_required');
  assert.match(source('App.jsx'), /<FreshProvider>/, 'one re-auth sheet for every page');
});
