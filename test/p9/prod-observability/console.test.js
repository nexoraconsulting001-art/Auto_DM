// The Observability screen of the Platform Console (G-14): the figures and their tones, the feature's registration, and that
// the page reads only the three routes it should and nothing per business beyond the one it was opened for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BusinessOps } from '../../../src/contracts/metrics.js';
import { PLATFORM_ROUTES } from '../../../shared/api-client/platform-routes.js';
import { QUEUE_BAD_SECONDS, QUEUE_WARN_SECONDS, USAGE_BAD_PERCENT, USAGE_WARN_PERCENT, WINDOWS, formatAge, hoursOf, lastWebhook, opsFigures, worstTone } from '../../../console/src/platform/features/observability/figures.js';
import { repoRoot } from '../../../tools/gate-lib.mjs';

const dir = path.join(repoRoot, 'console/src/platform/features/observability');
const ops = (extra = {}) => BusinessOps.parse({ tenantId: 1, since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', errors: 0, metaCalls: 0, metaThrottled: 0, metaUsagePercent: 0, queueDepth: 0, queueOldestSeconds: 0, ...extra });
const tones = (o) => Object.fromEntries(opsFigures(o).map((f) => [f.key, f.tone]));

test('G-14: a quiet business shows every figure as fine, and each number turns warm or red at the platform alerts\' own thresholds', () => {
  assert.deepEqual(Object.values(tones(ops())).filter((t) => !['good', 'neutral'].includes(t)), []);
  assert.equal(worstTone(opsFigures(ops())), 'neutral');
  assert.equal(opsFigures(ops()).length, 6);
  assert.equal(tones(ops({ errors: 3 })).errors, 'warn');
  assert.equal(tones(ops({ errors: 50 })).errors, 'bad');
  assert.equal(tones(ops({ metaCalls: 100, metaThrottled: 5 })).metaThrottled, 'warn');
  assert.equal(tones(ops({ metaCalls: 100, metaThrottled: 10 })).metaThrottled, 'bad');
  assert.equal(tones(ops({ metaUsagePercent: USAGE_WARN_PERCENT - 1 })).metaUsage, 'good');
  assert.equal(tones(ops({ metaUsagePercent: USAGE_WARN_PERCENT })).metaUsage, 'warn');
  assert.equal(tones(ops({ metaUsagePercent: USAGE_BAD_PERCENT })).metaUsage, 'bad');
  assert.equal(tones(ops({ queueOldestSeconds: QUEUE_WARN_SECONDS })).queueOldest, 'warn');
  assert.equal(tones(ops({ queueOldestSeconds: QUEUE_BAD_SECONDS })).queueOldest, 'bad');
  assert.equal(worstTone(opsFigures(ops({ metaUsagePercent: 99, errors: 1 }))), 'bad');
  assert.equal(opsFigures(ops({ metaUsagePercent: 83.4 })).find((f) => f.key === 'metaUsage').value, '83%');
});

test('G-14: the thresholds are the ones the platform alerts use, so a business shows before the alert fires', () => {
  const rules = fs.readFileSync(path.join(repoRoot, 'deploy/prod/monitoring/rules/sending.yaml'), 'utf8') + fs.readFileSync(path.join(repoRoot, 'deploy/prod/monitoring/rules/queue.yaml'), 'utf8');
  assert.match(rules, new RegExp(`meta_usage_ratio\\) > ${USAGE_WARN_PERCENT / 100}\\b`));
  assert.match(rules, new RegExp(`meta_usage_ratio\\) > ${USAGE_BAD_PERCENT / 100}\\b`));
  assert.match(rules, new RegExp(`queue_oldest_job_seconds\\) > ${QUEUE_WARN_SECONDS}\\b`));
  assert.match(rules, new RegExp(`queue_oldest_job_seconds\\) > ${QUEUE_BAD_SECONDS}\\b`));
});

test('G-14: ages read as words, the window is one of three, and the webhook line comes from the health check', () => {
  assert.deepEqual([0, -5, 'x', 45, 60, 90, 3600, 5400, 7200].map(formatAge), ['none', 'none', 'none', '45 s', '1 min', '1 min 30 s', '1 h', '1 h 30 min', '2 h']);
  assert.deepEqual(WINDOWS.map((w) => w.hours), [24, 168, 720]);
  assert.deepEqual(['24', 168, '720', 5, 'x', undefined, 0].map(hoursOf), [24, 168, 720, 24, 24, 24, 24]);
  const health = (status) => ({ checks: [{ check: 'account.graph', status: 'bad' }, { check: 'account.webhooks', status, lastRanAt: '2026-01-01T00:00:00Z' }] });
  assert.deepEqual(lastWebhook(health('ok')), { text: 'Arriving', tone: 'good', at: '2026-01-01T00:00:00Z' });
  assert.equal(lastWebhook(health('warn')).tone, 'warn');
  assert.equal(lastWebhook(health('bad')).text, 'Not arriving');
  assert.equal(lastWebhook(health('unreachable')).text, 'Could not be checked');
  assert.deepEqual(lastWebhook({ checks: [] }), { text: 'Not checked yet', tone: 'neutral', at: null });
  assert.equal(lastWebhook(null).text, 'Not checked yet');
});

test('G-14: the feature registers itself for support and super admin only, and its screens call only the routes they should', () => {
  const index = fs.readFileSync(path.join(dir, 'index.jsx'), 'utf8');
  assert.match(index, /name: 'observability'/);
  assert.match(index, /roles: \['super_admin', 'support'\]/);
  assert.match(index, /path: 'observability'/);
  assert.match(index, /path: 'observability\/:id'/);
  for (const route of ['platform.businessOps', 'platform.businesses', 'platform.businessHealth']) assert.deepEqual([...PLATFORM_ROUTES[route].platformRoles].includes('support'), true, route);
  assert.deepEqual([...PLATFORM_ROUTES['platform.businessOps'].platformRoles].sort(), ['super_admin', 'support']);
  const pages = fs.readFileSync(path.join(dir, 'pages.jsx'), 'utf8');
  assert.deepEqual([...new Set([...pages.matchAll(/\bapi\.(\w+)/g)].map((m) => m[1]).filter((name) => name !== 'js'))].sort(), ['businessHealth', 'businessOps', 'businesses']);
  assert.doesNotMatch(pages, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(pages + index + fs.readFileSync(path.join(dir, 'figures.js'), 'utf8'), /\bBhava (Pvt|Ltd)\b|seller/i, 'the console is Bhava\'s own');
});

test('G-14: the screens compile', async () => {
  const { transformWithOxc } = await import('vite');
  for (const file of ['index.jsx', 'pages.jsx']) {
    const out = await transformWithOxc(fs.readFileSync(path.join(dir, file), 'utf8'), file, { lang: 'jsx', jsx: { runtime: 'automatic' } });
    assert.ok(out.code.length > 100, file);
  }
});
