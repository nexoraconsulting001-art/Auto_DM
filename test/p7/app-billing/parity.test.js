import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const FEATURES = ['billing', 'signup', 'setup', 'referrals', 'ai-replies', 'whatsapp', 'team-feed'];
const dir = (name) => `apps/owner/src/features/${name}`;
const idsOf = (name) => { const src = fs.readFileSync(`${dir(name)}/index.js`, 'utf8'); const block = /routeIds: \[([\s\S]*?)\]/.exec(src)[1]; return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]); };

test('npm run parity is green with every Phase 7 seller route mapped', () => {
  const run = spawnSync(process.execPath, ['tools/parity-check.mjs'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('each owned feature lists its routes and the 45 together are the whole Phase 7 seller surface', () => {
  const all = FEATURES.flatMap(idsOf).filter((id) => /^(billing|referrals|signup|teamFeed|services|setup|faq|aiReplies|whatsapp)\./.test(id));
  assert.equal(new Set(all).size, all.length, 'a route is listed twice');
  assert.equal(all.length, 45);
});

test('no screen holds a price, a card field or a shortener', () => {
  for (const name of FEATURES) {
    for (const file of fs.readdirSync(dir(name)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'testing.js')) {
      const code = fs.readFileSync(`${dir(name)}/${file}`, 'utf8');
      assert.doesNotMatch(code, /cardNumber|cvv|creditCard\b|bit\.ly|console\.(log|info)/, `${name}/${file}`);
      assert.doesNotMatch(code, /(?:pricePaise|amountPaise|totalPaise)\s*:/, `${name}/${file} sends an amount`);
    }
  }
});

test('every buy, upgrade and pack button is behind BILLING_ACTIONS', () => {
  const screen = fs.readFileSync(`${dir('billing')}/BillingScreen.js`, 'utf8');
  for (const id of ['billing-pack-', 'billing-plans', 'billing-addons', 'billing-method', 'billing-cycle']) {
    const at = screen.indexOf(id);
    assert.ok(at > 0, id);
  }
  assert.match(screen, /useBillingActions\(\)/);
  assert.match(screen, /\{actions \? \(\s*<Section title=\{t\('billing\.plans\.title'\)\}/);
  assert.match(screen, /actions && plan\.data\?\.hasPaymentMethod/);
  assert.match(screen, /actions && usage\.canBuyPacks/);
});
