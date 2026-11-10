// The old single-shop sample is gone, and nothing still expects it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../src/config.js';
import { SETTING_DEFAULTS } from '../../../src/repos/settings.js';
import { RESERVED_SLUGS } from '../../../src/repos/tenants.js';
import { setup } from '../../helpers.js';
import { repoRoot } from './support.js';

const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const tracked = () => execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);

test('the old deployment files are gone', () => {
  for (const file of ['render.yaml', 'deploy/compose.yaml', 'deploy/.env.example', 'DEPLOY.md']) {
    assert.equal(fs.existsSync(path.join(repoRoot, file)), false, file);
  }
});

test('no code or config mentions the old forwarding, the plugin or the global token', () => {
  assert.equal('forwardWebhookUrl' in config, false);
  assert.equal('pluginUrl' in config, false);
  const here = 'test/p0/backend-gaps/';
  const files = tracked().filter((f) => !f.startsWith(here) && /\.(js|mjs|json|ya?ml|md|example)$/.test(f) && f !== 'package-lock.json' && !f.startsWith('seed/'));
  for (const file of files) {
    if (!fs.existsSync(path.join(repoRoot, file))) continue;
    const text = read(file);
    assert.doesNotMatch(text, /FORWARD_WEBHOOK_URL|PLUGIN_URL/, file);
    if (file.startsWith('src/')) assert.doesNotMatch(text, /IG_ACCESS_TOKEN|IG_USER_ID|config\.accessToken|config\.igUserId/, file);
  }
});

test('setting defaults name no shop', () => {
  assert.equal(SETTING_DEFAULTS.store_name, 'My store');
  assert.equal(SETTING_DEFAULTS.upi_payee, '');
  assert.doesNotMatch(JSON.stringify(SETTING_DEFAULTS), /shopping for her|mehta/i);
});

test('the QA deployment uses port 8140, and no file holds the old port', () => {
  const compose = read('deploy/bhava/compose.yaml');
  assert.match(compose, /127\.0\.0\.1:8140:8140/);
  for (const file of ['deploy/bhava/compose.yaml', 'deploy/bhava/README.md', 'deploy/bhava/.env.example']) {
    assert.doesNotMatch(read(file), /8120|VM-IP|sslip/, file);
  }
});

test('the adapter and contract folders exist for the tracks that fill them', () => {
  for (const dir of ['src/adapters', 'src/contracts']) assert.ok(fs.statSync(path.join(repoRoot, dir)).isDirectory(), dir);
});

test('reserved addresses cannot be taken, by slug, by name or directly in the database', async () => {
  const { db, platform } = await setup();
  assert.deepEqual([...RESERVED_SLUGS].sort(), ['admin', 'api', 'app', 'bhava', 'www']);
  for (const slug of RESERVED_SLUGS) {
    await assert.rejects(() => platform.tenants.create({ slug, name: 'Anything' }), /reserved/, slug);
    await assert.rejects(() => platform.tenants.create({ name: slug.toUpperCase() }), /reserved/, slug);
    await assert.rejects(() => platform.tenants.create({ slug: `  ${slug.toUpperCase()}!! `, name: 'Anything' }), /reserved/, slug);
    await assert.rejects(() => db.query(`INSERT INTO tenants (slug, name) VALUES ($1, 'x')`, [slug]), /check constraint/, slug);
  }
  assert.equal((await platform.tenants.create({ slug: 'bhava-mehta', name: 'Allowed' })).slug, 'bhava-mehta');
  assert.equal((await platform.tenants.create({ slug: 'admins', name: 'Allowed' })).slug, 'admins');
});
