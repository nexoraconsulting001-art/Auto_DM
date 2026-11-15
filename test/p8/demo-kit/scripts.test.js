// Q-10: the demo scripts in docs/showcase, read as text against the product. The browser walk of every step is e2e/p8/demo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exists, filesUnder, json, read } from '../spec-p8/support.js';
import { SHOWCASE } from '../../../src/contracts/seed.js';

const files = () => filesUnder('docs/showcase', { ext: ['.md'] }).filter((f) => !/readme|index/i.test(f.split('/').pop()));
const STEP = /^\s*(\d{1,3})[.)]\s+(.+)$/;
const steps = (text) => text.split(/\r?\n/).map((l) => STEP.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[1]), text: m[2] }));
const tokens = (step) => [...step.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
const isRoute = (t) => /^\/[A-Za-z0-9/_-]*$/.test(t);

const businesses = () => json(SHOWCASE.manifest).businesses.map((b) => json(`seed/showcase/${b.file}`).business);

test('Q-10: there is one script per sample business and each names its business', () => {
  const found = files();
  const owners = businesses();
  assert.ok(found.length >= owners.length);
  for (const owner of owners) {
    const own = found.filter((f) => read(f).includes(owner.name));
    assert.equal(own.length, 1, `exactly one script tells the story of ${owner.slug}`);
    for (const other of owners.filter((o) => o !== owner)) {
      assert.ok(!read(own[0]).includes(other.name), `${own[0]} does not mention ${other.name}`);
    }
  }
});

test('Q-10: the story runs from the reel comment to the branded app, in order, and says what is simulated', () => {
  const order = [/comment/i, /\bDM\b/, /landing page/, /checkout/i, /test mode/i, /track/i, /home/i, /inbox/i, /orders/i, /insights/i, /reach guard/i, /\bapp\b/i];
  for (const file of files()) {
    const text = read(file);
    const list = steps(text);
    assert.ok(list.length >= 10, file);
    assert.deepEqual(list.map((s) => s.n), list.map((_, i) => i + 1), `${file}: numbered in order`);
    assert.ok(list.every((s) => s.text.length <= 400), `${file}: a step fits a phone`);
    for (const pattern of order) assert.match(text, pattern, `${file}: ${pattern}`);
    assert.match(text, /simulat/i);
    // The reel comment comes before the DM, the page before checkout, and checkout before the owner's orders.
    const at = (pattern) => list.findIndex((s) => pattern.test(s.text));
    assert.ok(at(/comment/i) < at(/\bDM\b/), `${file}: comment, then DM`);
    assert.ok(at(/landing page/) < at(/checkout/i), `${file}: page, then checkout`);
    assert.ok(at(/checkout/i) < at(/orders/i), `${file}: checkout, then orders`);
  }
});

test('Q-10: a script needs no real account, no actual money and no deployed server', () => {
  for (const file of files()) {
    const text = read(file);
    for (const url of text.matchAll(/https?:\/\/[^\s)`>"']+/g)) {
      assert.match(new URL(url[0]).hostname, /(^localhost$|\.localhost$|\.example$|^example\.(com|org|net)$)/, `${file}: ${url[0]} is a real address`);
    }
    assert.doesNotMatch(text, /\b(real|live) (money|card|payment|upi)\b/i, file);
    assert.doesNotMatch(text, /(log ?in|sign ?in|connect)[^.\n]{0,40}(your|a|the) (real|own|personal) (instagram|facebook|whatsapp)/i, file);
    assert.doesNotMatch(text, /\+91\d{10}|@[a-z0-9-]+\.(com|in)\b/i, `${file}: shows a phone number or an address of a person`);
  }
});

test('Q-10: every console address a step names is a screen of the console', () => {
  const routes = [];
  for (const file of filesUnder('console/src/features', { ext: ['.jsx'] })) for (const m of read(file).matchAll(/path:\s*'([^']*)'/g)) routes.push(m[1]);
  assert.ok(routes.includes('settings/install'), 'the install page is registered');
  for (const file of files()) {
    for (const step of steps(read(file))) {
      for (const token of tokens(step.text).filter((t) => isRoute(t) && t.startsWith('/admin'))) {
        const rest = token.replace(/^\/admin\/?/, '');
        assert.ok(rest === '' || routes.includes(rest), `${file} step ${step.n}: ${token} is not a console screen`);
      }
    }
  }
});

test('Q-10: a script names a control only where the product still has it', () => {
  const sources = [...filesUnder('console/src', { ext: ['.jsx', '.js'] }), ...filesUnder('src', { ext: ['.js'] }), ...filesUnder('apps/shopper/src', { ext: ['.js', '.jsx'] })].map(read).join('\n');
  for (const file of files()) {
    for (const step of steps(read(file))) {
      for (const token of tokens(step.text).filter((t) => !isRoute(t))) assert.ok(sources.includes(token), `${file} step ${step.n}: "${token}" is gone`);
    }
  }
});

test('Q-10: the walk of the scripts is in the browser tests, one test per script', () => {
  assert.ok(exists('e2e/p8/demo/scripts.spec.js'));
  assert.match(read('e2e/p8/demo/scripts.spec.js'), /for \(const \[index, file\] of scripts\.entries\(\)\)/);
});
