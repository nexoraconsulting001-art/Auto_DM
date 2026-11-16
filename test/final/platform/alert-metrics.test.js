// platform-3: every metric an alert rule reads is emitted by the code, where the event happens. Six catalogued metrics
// (compliance_outcomes_total, sends_accepted_total, provider_calls_total, webhook_stored_total, webhook_processed_total,
// secret_refresh_failures_total) were named by rules in deploy/prod/monitoring/rules and emitted nowhere, so the send,
// webhook-loss, provider and secret alerts could never fire.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_METRICS, METRICS } from '../../../src/contracts/metrics.js';
import { createHttp, onProviderCall } from '../../../src/adapters/http.js';
import { createMetrics, secretRefreshFailed, sendOutcomeLabels } from '../../../src/platform/metrics.js';
import { createOpsMetrics } from '../../../src/modules/ops-metrics/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir, test) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, test) : test(e.name) ? [full] : [];
  });
}

test('platform-3: every catalogued metric an alert rule names is emitted somewhere in the code (optional-call forms included)', () => {
  const rules = walk(path.join(ROOT, 'deploy/prod/monitoring/rules'), (n) => n.endsWith('.yaml') && !n.includes('test')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const named = Object.keys(METRICS).filter((name) => new RegExp(`\\b${name}(_bucket|_sum|_count)?\\b`).test(rules));
  const code = walk(path.join(ROOT, 'src'), (n) => n.endsWith('.js')).filter((f) => !f.includes(`${path.sep}contracts${path.sep}`)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const emitted = new Set([...code.matchAll(/\.(?:inc|observe|gauge)\??\.?\(\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]));
  // backup_age_seconds is written with backup_last_success_seconds (src/platform/metrics.js).
  if (emitted.has('backup_last_success_seconds')) emitted.add('backup_age_seconds');
  assert.ok(named.length > 10);
  assert.deepEqual(named.filter((name) => !emitted.has(name) && !EXTERNAL_METRICS.includes(name)), []);
});

test('platform-3: a send decision is counted by channel, outcome and the family of its reason; an accepted send also as sends_accepted_total', () => {
  assert.deepEqual(sendOutcomeLabels('instagram', { outcome: 'sent', reason: '' }), { channel: 'instagram', outcome: 'sent', family: 'none', accepted: true });
  assert.deepEqual(sendOutcomeLabels('whatsapp', { outcome: 'sent_fallback', reason: 'fallback.validation' }), { channel: 'whatsapp', outcome: 'sent', family: 'fallback', accepted: true });
  assert.deepEqual(sendOutcomeLabels('instagram', { outcome: 'held', reason: 'held.review' }), { channel: 'instagram', outcome: 'blocked', family: 'held', accepted: false });
  assert.deepEqual(sendOutcomeLabels('facebook', { outcome: 'skipped', reason: 'paused.global' }), { channel: 'facebook', outcome: 'skipped', family: 'paused', accepted: false });
  assert.equal(sendOutcomeLabels('instagram', { outcome: 'unknown', reason: 'send.unknown_outcome' }).outcome, 'failed');
  assert.equal(sendOutcomeLabels('instagram', { outcome: 'queued', reason: 'rate.throttled' }).outcome, 'queued');
  assert.equal(sendOutcomeLabels('email', { outcome: 'sent', reason: '' }), null, 'a channel outside the label set is not counted');
  const metrics = createMetrics({ strict: true });
  for (const o of ['queued', 'held', 'sent', 'sent_fallback', 'unknown', 'failed', 'cancelled', 'expired', 'skipped', 'would_send']) {
    const l = sendOutcomeLabels('instagram', { outcome: o, reason: 'cap.per_comment' });
    metrics.inc('compliance_outcomes_total', { channel: l.channel, outcome: l.outcome, family: l.family });
  }
  assert.deepEqual(metrics.rejected?.() ?? [], []);
});

test('platform-3: every call through the shared provider HTTP adapter is counted as provider_calls_total', async (t) => {
  const metrics = createMetrics({ strict: true });
  const ctx = { platform: { metrics, analytics: { track() {} }, queue: {} }, db: null, service: 'worker' };
  createOpsMetrics(ctx).wire();
  const seen = [];
  t.after(onProviderCall((call) => seen.push(call)));
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const answers = [new Response('{"ok":true}', { status: 200 }), new Response('{"error":"x"}', { status: 503 })];
  globalThis.fetch = async () => answers.shift();
  const request = createHttp({ provider: 'shiprocket', baseUrl: 'http://127.0.0.1:9' });
  await request('GET', '/a');
  await assert.rejects(request('GET', '/b'));
  assert.deepEqual(seen, [{ provider: 'shiprocket', result: 'ok' }, { provider: 'shiprocket', result: 'server' }]);
  const text = await metrics.render();
  assert.match(text, /provider_calls_total\{provider="shiprocket",result="ok"\} 1/);
  assert.match(text, /provider_calls_total\{provider="shiprocket",result="server"\} 1/);
});

test('platform-3: a failed refresh of the secret source counts secret_refresh_failures_total once the platform exists', async () => {
  let metrics = null;
  const onAlert = secretRefreshFailed(() => metrics);
  onAlert({ code: 'secrets.read_failed' }); // before the platform: reported, not counted, never throws
  metrics = createMetrics({ strict: true });
  onAlert({ code: 'secrets.read_failed' });
  assert.match(await metrics.render(), /secret_refresh_failures_total 1/);
});
