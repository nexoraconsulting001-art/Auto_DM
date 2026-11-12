// The Maestro flows in apps/shopper/.maestro (PRD 10.7 to 10.13, run by android-e2e in .github/workflows/brand-apps.yml).
// No emulator runs here. What can be proved without one: every flow parses, every element it touches is a testID the shopper
// app renders, every value it uses is one the job's server hands it, and every journey the task names has a flow. The server
// half of each flow is rehearsed in journey.test.js.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYamlDocs } from '../../p5/app-release/yaml-lite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAESTRO = path.join(ROOT, 'apps/shopper/.maestro');
const read = (file) => fs.readFileSync(file, 'utf8');
const { flowEnv } = await import(pathToFileURL(path.join(MAESTRO, 'support/server.mjs')).href);
const FIXTURES = path.join(ROOT, 'tools/build-brand/fixtures');
const brands = fs.readdirSync(FIXTURES).filter((n) => fs.existsSync(path.join(FIXTURES, n, 'brand.json')));
const brandOf = (name) => JSON.parse(read(path.join(FIXTURES, name, 'brand.json')));

// ---- what the app renders ----

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.jsx?$/.test(entry.name) && !/\.test\./.test(entry.name) && !/fixture/.test(entry.name)) out.push(full);
  }
  return out;
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateRegex = (template) => template.split(/\$\{[^}]*\}/).map(escape).join('.+');

/** Every testID in the app and its packages: literals, templates (`order-${id}`), and ids built from a parent's (`${testID}-confirm`). */
function appTestIds() {
  const literals = new Set();
  const templates = [];
  const suffixes = [];
  const files = ['apps/shopper/src', 'packages/ui/src', 'packages/app-core/src'].flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
  for (const file of files) {
    for (const line of read(file).split('\n')) {
      if (!/testID|tabBarButtonTestID/i.test(line)) continue;
      for (const match of line.matchAll(/(?:testID|tabBarButtonTestID)\s*[=:]\s*\{?\s*(["'])([^"'\s]+)\1/gi)) literals.add(match[2]);
      for (const match of line.matchAll(/`([^`]*)`/g)) {
        const text = match[1];
        if (!text.includes('${')) continue;
        if (/^\$\{[^}]*\}/.test(text)) {
          // `${testID}-confirm`: a fixed word after the parent's id. `${testID}-${value}` says nothing a flow may rely on.
          const rest = text.replace(/^\$\{[^}]*\}/, '');
          if (/[A-Za-z]/.test(rest.replace(/\$\{[^}]*\}/g, ''))) suffixes.push(new RegExp(`^${templateRegex(rest)}$`));
        } else templates.push(new RegExp(`^${templateRegex(text)}$`));
      }
    }
  }
  return { literals, templates, suffixes };
}
const ids = appTestIds();
function rendered(id) {
  if (ids.literals.has(id) || ids.templates.some((pattern) => pattern.test(id))) return true;
  for (const literal of ids.literals) {
    if (id.startsWith(literal) && ids.suffixes.some((pattern) => pattern.test(id.slice(literal.length)))) return true;
  }
  return false;
}

// ---- the flows ----

const flowFiles = (dir) => fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => path.join(dir, name));
const TOP = flowFiles(MAESTRO);
const SHARED = flowFiles(path.join(MAESTRO, 'common'));
const SHOTS = flowFiles(path.join(MAESTRO, 'shots'));

function parseFlow(file) {
  const [header, commands] = parseYamlDocs(read(file));
  assert.ok(header && Array.isArray(commands), `${path.relative(ROOT, file)} is not a header and a list of commands`);
  return { file, header, commands };
}
function* commandsOf(list) {
  for (const command of list) {
    yield command;
    const body = typeof command === 'object' ? Object.values(command)[0] : null;
    if (body && Array.isArray(body.commands)) yield* commandsOf(body.commands);
  }
}
function selectorIds(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => selectorIds(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'id' && typeof v === 'string') out.push(v);
      else if (key !== 'env') selectorIds(v, out);
    }
  }
  return out;
}
const variablesIn = (text) => [...String(text).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
/** A concrete id for a selector: values put in, and a regex wildcard made a plain part. */
const samples = (id) => id.split('|').map((alt) => alt.replace(/\$\{[^}]+\}/g, 'x7').replace(/\.\*/g, '7'));

const seeded = { tenantId: 7101, productSlug: 'flow-test-mug' };
const SAMPLE_ENV = flowEnv(brandOf(brands[0]), seeded, { apiUrl: 'http://127.0.0.1:3000', appHost: '10.0.2.2', simUrls: { whatsapp: 'http://127.0.0.1:9102', razorpay: 'http://127.0.0.1:9103' } });

describe('the flows, read', () => {
  const top = TOP.map(parseFlow);
  const shared = SHARED.map(parseFlow);
  const shots = SHOTS.map(parseFlow);
  const everything = [...top, ...shared, ...shots];

  test('P-27 to P-30, P-46, P-50, P-64: there is a flow for each journey of the brand app, at the top of .maestro where Maestro runs them', () => {
    const names = top.map((flow) => String(flow.header.name));
    for (const id of ['P-27', 'P-28', 'P-29', 'P-30', 'P-46', 'P-50', 'P-64']) assert.ok(names.some((name) => name.startsWith(`${id}:`)), `no flow is named for ${id}`);
    assert.ok(top.some((flow) => path.basename(flow.file) === 'launch.yaml'), 'the opening smoke flow is still there');
    for (const flow of everything) {
      assert.equal(flow.header.appId, '${APP_ID}', `${path.basename(flow.file)}: the app id comes from the job`);
      assert.ok(flow.header.name, `${path.basename(flow.file)} has no name`);
    }
    // Shared steps and the screenshot flow are not requirements: the gate counts a flow by its name.
    for (const flow of [...shared, ...shots]) assert.doesNotMatch(String(flow.header.name), /^[A-Z]{1,3}-\d+/);
  });

  test('each journey does what the task names, in the app', () => {
    const text = (name) => read(path.join(MAESTRO, name));
    const commonText = (name) => read(path.join(MAESTRO, 'common', name));
    // Browse without sign-in, product from a link.
    assert.match(text('browse.yaml'), /assertNotVisible:\s*\n\s*id: screen-sign-in/);
    assert.match(text('deep-link.yaml'), /openLink: \$\{APP_SCHEME\}:\/\/p\/\$\{PRODUCT_SLUG\}/);
    // Guest checkout with the payment simulator's test card, "Paid" in the app, said only after the server says so.
    const paid = text('guest-checkout-paid.yaml');
    assert.match(paid, /support\/pay\.js/);
    assert.match(paid, /Paid\. Thank you!/);
    assert.doesNotMatch(paid, /id: tab-account/, 'a guest checkout does not go through the account');
    assert.match(read(path.join(MAESTRO, 'support/pay.js')), /method: 'card'/);
    // Cash on delivery with a WhatsApp code, the order under Orders, its tracking.
    assert.match(commonText('place-cod.yaml'), /support\/code\.js/);
    const cod = text('cod-order.yaml');
    for (const id of ['row-orders', 'order-track', 'screen-tracking', 'status-track']) assert.match(cod, new RegExp(`id: ${id}`), `${id} is not used`);
    // Notifications after the first order only.
    const notifications = text('notifications-after-first-order.yaml');
    assert.ok(notifications.indexOf('assertNotVisible') < notifications.indexOf('explainer-yes'), 'the explainer is checked absent before the order');
    assert.match(notifications, /id: explainer-yes/);
    // Reorder, delete the account.
    assert.match(text('reorder.yaml'), /id: order-reorder/);
    const del = text('delete-account.yaml');
    assert.ok(del.indexOf('delete-sheet-confirm') > del.indexOf('delete-start'), 'one deliberate confirmation after the button');
    assert.match(del, /assertNotVisible:\s*\n\s*id: account-sign-out/);
  });

  test('every element a flow touches is a testID the app renders', () => {
    const missing = [];
    for (const flow of everything) {
      for (const command of commandsOf(flow.commands)) {
        for (const id of selectorIds(command)) {
          for (const sample of samples(id)) if (!rendered(sample)) missing.push(`${path.basename(flow.file)}: ${id}`);
        }
      }
    }
    assert.deepEqual(missing, []);
    // And the check would see a typo.
    assert.equal(rendered('sign-in-phon'), false);
    assert.equal(rendered('cod-vrify'), false);
    assert.equal(rendered('delete-sheet-confirm'), true);
    assert.equal(rendered('order-A-1000'), true);
  });

  test('every file a flow runs exists, and a flow in a folder is run by a flow at the top', () => {
    const used = new Set();
    for (const flow of everything) {
      for (const command of commandsOf(flow.commands)) {
        const [name, body] = typeof command === 'object' ? Object.entries(command)[0] : [command, null];
        if (name === 'runScript' || (name === 'runFlow' && body?.file)) {
          const file = path.resolve(path.dirname(flow.file), name === 'runScript' ? body.file ?? body : body.file);
          assert.ok(fs.existsSync(file), `${path.basename(flow.file)} runs ${body?.file ?? body}, which does not exist`);
          used.add(file);
        }
      }
    }
    for (const flow of shared) assert.ok(used.has(flow.file), `${path.basename(flow.file)} is run by no flow`);
    // The screenshot flow is run by the capture scripts, not by a flow.
    const capture = read(path.join(ROOT, 'tools/listing-shots/capture-android.sh'));
    assert.match(capture, /apps\/shopper\/\.maestro\/shots\/shots\.yaml/);
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
    for (const flow of [...shared, ...shots]) {
      const own = passed.get(`common/${path.basename(flow.file)}`) ?? new Set();
      for (const name of variablesIn(read(flow.file))) if (!name.startsWith('output.')) assert.ok(global.has(name) || own.has(name), `${path.basename(flow.file)} uses \${${name}}, which no caller passes`);
    }
    // The scripts' own inputs are passed by the flow that runs them.
    for (const [script, wanted] of [['code.js', ['PHONE', 'SIM_WHATSAPP_URL']], ['pay.js', ['SIM_RAZORPAY_URL']]]) {
      const callers = everything.flatMap((flow) => [...commandsOf(flow.commands)].filter((c) => typeof c === 'object' && c.runScript?.file?.endsWith(script)));
      assert.ok(callers.length, `${script} is run by no flow`);
      for (const call of callers) for (const name of wanted) assert.ok(call.runScript.env?.[name], `a flow runs ${script} without ${name}`);
    }
  });

  test('P-01, P-31: no flow names a brand, the platform, or a real key or business', () => {
    for (const flow of everything) {
      const text = read(flow.file);
      assert.doesNotMatch(text, new RegExp(['bha', 'va'].join(''), 'i'));
      assert.doesNotMatch(text, /rzp_(?:live|test)_[A-Za-z0-9]{10,}/);
      for (const name of brands) {
        const brand = brandOf(name);
        for (const word of [brand.name, brand.shortName, brand.scheme, brand.android?.package]) assert.ok(!word || !text.toLowerCase().includes(word.toLowerCase()), `${path.basename(flow.file)} names the brand ${word}`);
      }
    }
    for (const file of ['code.js', 'pay.js']) assert.doesNotMatch(read(path.join(MAESTRO, 'support', file)), /https?:\/\/(?!\s)[a-z0-9.-]+\.(com|in|io)\b/i, `${file} reaches a real host`);
  });

  test('the scripts are plain ES5 that Maestro runs, and reach only the simulators they are given', () => {
    for (const file of ['code.js', 'pay.js']) {
      const text = read(path.join(MAESTRO, 'support', file));
      assert.doesNotMatch(text, /=>|\blet\b|\bconst\b|`/, `${file} is not ES5`);
      for (const url of text.matchAll(/http\.(?:get|post)\(([^,)]+)/g)) assert.match(url[1], /^SIM_(WHATSAPP|RAZORPAY)_URL/, `${file} calls ${url[1]}`);
    }
  });
});
