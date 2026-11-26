// Monitoring (PRD 11: availability, observability; G-06 alert rules, G-07 dashboards, G-13 the 99.5% objective): every rule and
// dashboard names only catalogue metrics and labels, each alert fires on its bad input and clears on recovery, the routes
// group by alert and send by severity, and the probe feeds the objective.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FORBIDDEN_LABELS, METRIC_LABELS, UPTIME_SLO } from '../../../src/contracts/metrics.js';
import { MONITORING, allDashboards, allRecordings, allRules, expandRecorded, expressionProblems, files, readYaml } from './lib.js';
import { evaluate, expandValues, parse, parseDuration, runRuleTests } from './promql.js';

const rules = allRules();
const readme = fs.readFileSync(path.join(MONITORING, 'README.md'), 'utf8');

test('G-06: every rule is complete: a name, a severity of page or ticket, an area, plain annotations and a runbook that exists', () => {
  assert.ok(rules.length >= 30, `${rules.length} rules`);
  assert.equal(new Set(rules.map((r) => r.alert)).size, rules.length, 'alert names are unique');
  const headings = new Set([...readme.matchAll(/^#### (\w+)$/gm)].map((m) => m[1].toLowerCase()));
  for (const rule of rules) {
    assert.match(rule.alert, /^[A-Z][A-Za-z]+$/);
    assert.ok(['page', 'ticket'].includes(rule.labels?.severity), `${rule.alert} severity`);
    assert.ok(['webhooks', 'queue', 'sending', 'store', 'database', 'runtime', 'slo'].includes(rule.labels?.area), `${rule.alert} area`);
    assert.deepEqual(Object.keys(rule.labels).sort(), ['area', 'severity'], `${rule.alert} adds no other label`);
    assert.ok(rule.for, `${rule.alert} waits before it fires`);
    for (const note of ['summary', 'description', 'runbook']) assert.ok(rule.annotations?.[note]?.length > 10, `${rule.alert} ${note}`);
    assert.doesNotMatch(JSON.stringify(rule.annotations), /\{\{|\$labels|\$value/, `${rule.alert}: no template, so no label or value is quoted`);
    const anchor = /README\.md#(\w+)$/.exec(rule.annotations.runbook)?.[1];
    assert.ok(anchor && headings.has(anchor), `${rule.alert}: the README has a section ${anchor}`);
    assert.equal(anchor, rule.alert.toLowerCase());
  }
  assert.equal(headings.size, rules.length, 'every README section is a rule');
});

test('G-06: the rules cover everything the brief names, with a page for what customers feel and a ticket for what can wait', () => {
  const byName = Object.fromEntries(rules.map((r) => [r.alert, r]));
  const covered = {
    'webhook intake failing': 'WebhookIntakeFailing', 'webhook intake slow': 'WebhookIntakeSlow', 'queue growing': 'QueueGrowing', 'oldest job too old': 'QueueOldestJobTooOld',
    'sends failing': 'SendsFailing', 'sends held': 'SendsHeld', 'compliance breaker or kill switch': 'ComplianceGateEngaged', 'meta throttling': 'MetaThrottling', 'meta token failures': 'MetaTokenFailuresRising',
    'payment webhook failures': 'PaymentWebhookFailing', 'courier webhook failures': 'CourierWebhookFailing', 'billing charge failures': 'BillingChargesFailing', 'backup too old': 'BackupTooOld',
    'database connections': 'DatabaseConnectionsNearLimit', 'memory near the limit': 'MemoryNearLimit', 'error rate': 'StoreErrorRate', 'certificate expiry': 'CertificateExpiringSoon', 'secret refresh failing': 'SecretRefreshFailing',
    'burn: fast': 'UptimeBurnFast', 'burn: slow': 'UptimeBurnSlow', 'burn: ticket': 'UptimeBurnTicket',
  };
  for (const [what, name] of Object.entries(covered)) assert.ok(byName[name], what);
  for (const name of ['WebhookIntakeFailing', 'SendsFailing', 'ComplianceGateEngaged', 'BackupTooOld', 'StoreErrorRate', 'QueueStuck', 'PaymentWebhookFailing']) assert.equal(byName[name].labels.severity, 'page', name);
  for (const name of ['QueueGrowing', 'SendsHeld', 'MetaThrottling', 'CertificateExpiringSoon', 'SecretRefreshFailing', 'UptimeBurnTicket']) assert.equal(byName[name].labels.severity, 'ticket', name);
  assert.ok(byName.ComplianceGateEngaged.expr.includes('family="paused"'), 'the breaker and the kill switch are the paused family of the gate');
});

test('G-06: every rule names only metrics in the catalogue, only labels those metrics have, and no counter is treated as a gauge', () => {
  for (const rule of rules) assert.deepEqual(expressionProblems(expandRecorded(rule.expr)), [], rule.alert);
  for (const rule of allRecordings()) assert.deepEqual(expressionProblems(rule.expr), [], rule.record);
});

test('G-06: the catalogue check itself fails on a made-up metric, a forbidden or unknown label, a value outside a label\'s set, and rate() of a gauge', () => {
  for (const [expr, why] of [
    ['sum(rate(made_up_total[5m])) > 1', /not in the catalogue/],
    ['sum by (tenant_id) (rate(http_requests_total[5m])) > 1', /forbidden label tenant_id/],
    ['sum(rate(http_requests_total{path="/a"}[5m])) > 1', /forbidden label path/],
    ['sum(rate(http_requests_total{provider="meta"}[5m])) > 1', /no label provider/],
    ['sum by (queue) (rate(http_requests_total[5m])) > 1', /grouped by queue/],
    ['sum(rate(meta_calls_total{call_class="bogus"}[5m])) > 1', /outside its set/],
    ['sum(rate(webhook_received_total{provider="nobody"}[5m])) > 1', /outside its set/],
    ['rate(queue_oldest_job_seconds[5m]) > 1', /is a gauge/],
    ['sum(rate(http_requests_total[5m]', /does not parse/],
    ['node_cpu_seconds_total > 1', /not in the catalogue/],
  ]) assert.match(expressionProblems(expr).join(' | '), why, expr);
  assert.deepEqual(expressionProblems('sum by (provider) (rate(webhook_received_total{result="refused"}[5m])) > 1'), []);
  assert.deepEqual(expressionProblems('histogram_quantile(0.95, sum by (le) (rate(http_request_seconds_bucket{group="webhook"}[5m]))) > 2'), []);
});

test('G-06: every alert has a promtool test in which it fires on its bad input and is gone after recovery', () => {
  const tests = files('rules/tests', '.yaml').flatMap((f) => readYaml(`rules/tests/${f}`).tests.map((t) => ({ ...t, file: f })));
  for (const rule of rules) {
    const own = tests.filter((t) => t.alert_rule_test.some((c) => c.alertname === rule.alert));
    assert.ok(own.length >= 1, `${rule.alert} has a test`);
    const ok = own.some((t) => {
      const checks = t.alert_rule_test.filter((c) => c.alertname === rule.alert).map((c) => ({ at: parseDuration(c.eval_time), fires: (c.exp_alerts ?? []).length > 0 }));
      const firing = checks.filter((c) => c.fires).map((c) => c.at);
      return firing.length > 0 && checks.some((c) => !c.fires && c.at > Math.min(...firing));
    });
    assert.ok(ok, `${rule.alert} fires and then clears in one test`);
  }
  for (const f of files('rules', '.yaml')) assert.ok(files('rules/tests', '.yaml').includes(f), `${f} has a test file`);
});

for (const file of files('rules/tests', '.yaml')) {
  test(`G-06: ${file}: each alert fires on bad input and clears on recovery (evaluated here, and by promtool in CI)`, () => {
    const rows = runRuleTests(path.join(MONITORING, 'rules/tests', file));
    assert.ok(rows.length >= 2);
    assert.deepEqual(rows.filter((r) => !r.ok).map((r) => `${r.alert} at ${r.time}: ${r.why}`), []);
    assert.ok(rows.some((r) => r.gotCount > 0) && rows.some((r) => r.gotCount === 0 && r.expectedCount === 0));
  });
}

test('G-06: the tests fail when a rule is wrong: a threshold that never trips, a label that does not exist, a rule that never clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-rules-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  const copy = (file, edit) => {
    const text = edit(fs.readFileSync(path.join(MONITORING, 'rules', file), 'utf8'));
    fs.writeFileSync(path.join(dir, file), text);
    fs.writeFileSync(path.join(dir, 'tests', file), fs.readFileSync(path.join(MONITORING, 'rules/tests', file), 'utf8'));
    return runRuleTests(path.join(dir, 'tests', file)).filter((r) => !r.ok).map((r) => r.alert);
  };
  assert.deepEqual(copy('queue.yaml', (t) => t), [], 'untouched, it passes');
  assert.deepEqual([...new Set(copy('queue.yaml', (t) => t.replace('max by (queue) (queue_oldest_job_seconds) > 600', 'max by (queue) (queue_oldest_job_seconds) > 60000')))], ['QueueOldestJobTooOld']);
  assert.deepEqual([...new Set(copy('queue.yaml', (t) => t.replace('max by (queue) (queue_oldest_job_seconds) > 1800', 'max by (queue) (queue_oldest_job_seconds) > -1')))], ['QueueStuck']);
  assert.deepEqual([...new Set(copy('queue.yaml', (t) => t.replace('for: 5m\n        labels:\n          severity: ticket', 'for: 6h\n        labels:\n          severity: ticket')))], ['QueueOldestJobTooOld']);
  assert.deepEqual([...new Set(copy('queue.yaml', (t) => t.replace('severity: page', 'severity: ticket')))], ['QueueStuck']);
});

test('the evaluator itself: rate and increase extrapolate as Prometheus does, quantiles interpolate, and the set operators and offsets work', () => {
  const store = (series) => series.map(([name, values]) => ({ labels: { __name__: name.split('{')[0], ...Object.fromEntries([...(name.match(/(\w+)="([^"]*)"/g) ?? [])].map((m) => m.split('=').map((x) => x.replace(/"/g, '')))) }, samples: expandValues(values).map((v, i) => ({ t: i * 60_000, v })).filter((s) => s.v !== null) }));
  const s = store([
    ['hits{k="a"}', '0+60x20'], ['hits{k="b"}', '0+0x20'], ['gauge{k="a"}', '5+0x20'], ['lat_bucket{le="1"}', '0+30x20'], ['lat_bucket{le="2"}', '0+60x20'], ['lat_bucket{le="+Inf"}', '0+60x20'],
    ['grow{k="a"}', '0+10x30'],
  ]);
  const at = (expr, minutes) => evaluate(parse(expr), s, minutes * 60_000).map((r) => [r.labels, Math.round(r.value * 1000) / 1000]);
  assert.deepEqual(at('rate(hits[5m])', 10), [[{ k: 'a' }, 1], [{ k: 'b' }, 0]]);
  assert.deepEqual(at('increase(hits{k="a"}[5m])', 10), [[{ k: 'a' }, 300]]);
  assert.deepEqual(at('sum(rate(hits[5m]))', 10), [[{}, 1]]);
  assert.deepEqual(at('sum by (k) (rate(hits[5m])) > 0.5', 10), [[{ k: 'a' }, 1]]);
  assert.deepEqual(at('histogram_quantile(0.5, sum by (le) (rate(lat_bucket[5m])))', 10), [[{}, 1]]);
  assert.deepEqual(at('histogram_quantile(0.75, sum by (le) (rate(lat_bucket[5m])))', 10), [[{}, 1.5]]);
  assert.deepEqual(at('gauge > 1 and hits > 0', 10), [[{ k: 'a' }, 5]]);
  assert.deepEqual(at('gauge > 1 unless hits > 0', 10), []);
  assert.deepEqual(at('absent(nothing)', 10), [[{}, 1]]);
  assert.deepEqual(at('absent(gauge)', 10), []);
  assert.deepEqual(at('grow > grow offset 5m', 10), [[{ k: 'a' }, 100]]);
  assert.deepEqual(at('grow > grow offset 5m', 2), [], 'before the offset there is nothing to compare with');
  assert.deepEqual(at('gauge * 2 + 1', 3), [[{ k: 'a' }, 11]]);
  assert.deepEqual(at('time() - 60', 3), [[{}, 120]]);
  assert.deepEqual(at('avg_over_time(grow[3m])', 10), [[{ k: 'a' }, 85]]);
  assert.deepEqual(at('count(hits)', 10), [[{}, 2]]);
  assert.throws(() => parse('sum(rate(hits[5m])) offset'), /Unexpected/);
  assert.throws(() => parse('hits @ 5'), /Unexpected/);
  assert.deepEqual(expandValues('1+2x3 _ _x2 7 stale 4-1x1').map((v) => (Number.isNaN(v) ? 'nan' : v)), [1, 3, 5, 7, null, null, null, 7, 'nan', 4, 3]);
  assert.equal(parseDuration('1h30m'), 5_400_000);
});

test('G-13: the burn-rate alerts are the contract\'s (windows, rates and severities) over the probe of each objective, and fire only when both windows are bad', () => {
  assert.equal(UPTIME_SLO.objective, 0.995);
  const burn = rules.filter((r) => r.alert.startsWith('UptimeBurn'));
  assert.equal(burn.length, UPTIME_SLO.burnAlerts.length);
  for (const spec of UPTIME_SLO.burnAlerts) {
    // D2 decision (R2-PROD-E1): the factor is visible. The alerts read a named recording rule (errors / 0.005 over a window) and fire
    // above the contract's burn rate; the windows and the probes are read through that rule, so the expressions are expanded first.
    const rule = burn.find((r) => expandRecorded(r.expr).includes(`[${spec.longWindow}]`) && expandRecorded(r.expr).includes(`[${spec.shortWindow}]`));
    assert.ok(rule, `${spec.longWindow}/${spec.shortWindow}`);
    assert.equal(rule.labels.severity, spec.severity);
    const limits = [...rule.expr.matchAll(/> ([\d.]+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(limits, [spec.burnRate, spec.burnRate], `${rule.alert} trips above a burn rate of ${spec.burnRate} on both windows`);
    const budget = (1 - UPTIME_SLO.objective).toFixed(3);
    const used = allRecordings().filter((r) => rule.expr.includes(r.record));
    assert.equal(used.length, 2, `${rule.alert} reads a recorded burn rate for each window`);
    for (const record of used) assert.ok(record.expr.trim().endsWith(`/ ${budget}`), `${record.record} divides the error rate by the budget ${budget}`);
    for (const probe of UPTIME_SLO.probes) assert.match(expandRecorded(rule.expr), new RegExp(`${probe}`));
    assert.match(rule.expr, / and /);
  }
  assert.deepEqual(UPTIME_SLO.probes, ['webhook', 'shopper_page']);
  assert.ok(rules.some((r) => r.alert === 'ProbeDown'));
});

test('G-13: a short outage pages and then clears, a thin steady failure only opens a ticket, and a long outage does all three', () => {
  const bad = (samples) => ['probe_success{probe="webhook",instance="p1"}', samples];
  const good = (n) => ['probe_success{probe="shopper_page",instance="p1"}', `1+0x${n - 1}`];
  const run = (series, alert, minutes) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-slo-'));
    const cases = alert.map((name) => ({ name, interval: '1m', input_series: series.map(([s, v]) => ({ series: s, values: v })), alert_rule_test: [{ eval_time: `${minutes}m`, alertname: name, exp_alerts: [] }] }));
    fs.writeFileSync(path.join(dir, 'slo.yaml'), fs.readFileSync(path.join(MONITORING, 'rules/slo.yaml'), 'utf8'));
    const doc = { rule_files: ['slo.yaml'], evaluation_interval: '1m', tests: cases };
    fs.writeFileSync(path.join(dir, 't.yaml'), JSON.stringify(doc));
    return runRuleTests(path.join(dir, 't.yaml')).map((r) => [r.alert, r.gotCount > 0]);
  };
  // Twelve minutes down: the fast burn pages while it lasts, the slow one has not waited long enough, and an hour after the outage
  // ended both pages are gone (their short windows have recovered) while the ticket stays: its 6 hour window still holds the outage.
  const ALL = ['UptimeBurnFast', 'UptimeBurnSlow', 'UptimeBurnTicket'];
  assert.deepEqual(run([bad('1+0x9 0+0x11 1+0x80'), good(101)], ALL, 20), [['UptimeBurnFast', true], ['UptimeBurnSlow', false], ['UptimeBurnTicket', false]]);
  assert.deepEqual(run([bad('1+0x9 0+0x11 1+0x80'), good(101)], ALL, 100), [['UptimeBurnFast', false], ['UptimeBurnSlow', false], ['UptimeBurnTicket', true]]);
  // One failed probe in forty, steadily, all day: past the ticket's 0.5% but never the page's 3% or 7.2%.
  const thin = Array.from({ length: 2000 }, (_, i) => (i % 40 === 0 ? '0' : '1')).join(' ');
  const steady = run([bad(thin), good(2000)], ['UptimeBurnFast', 'UptimeBurnSlow', 'UptimeBurnTicket'], 1990);
  assert.deepEqual(steady, [['UptimeBurnFast', false], ['UptimeBurnSlow', false], ['UptimeBurnTicket', true]]);
  // Everything down for two hours: all three.
  const down = run([bad('1+0x9 0+0x130'), good(141)], ['UptimeBurnFast', 'UptimeBurnSlow', 'UptimeBurnTicket'], 130);
  assert.deepEqual(down.map(([, fired]) => fired), [true, true, true]);
});

test('G-07: five dashboards parse, each panel queries only catalogue metrics, and no variable or label is per business', () => {
  const dashboards = allDashboards();
  assert.deepEqual(dashboards.map((d) => d.file), ['database-and-runtime.json', 'platform-overview.json', 'sending-and-compliance.json', 'store-and-payments.json', 'webhooks-and-queue.json']);
  assert.equal(new Set(dashboards.map((d) => d.uid)).size, 5);
  for (const d of dashboards) {
    assert.ok(d.title && d.uid && d.schemaVersion >= 30, d.file);
    assert.ok(d.panels.length >= 7, `${d.file} has ${d.panels.length} panels`);
    assert.deepEqual(d.templating.list.map((v) => v.type), ['datasource'], `${d.file}: its only variable picks the data source`);
    assert.equal(new Set(d.panels.map((p) => p.id)).size, d.panels.length);
    for (const p of d.panels) {
      assert.ok(p.title && p.targets.length >= 1 && p.gridPos.w > 0, `${d.file}: ${p.title}`);
      for (const t of p.targets) {
        assert.deepEqual(expressionProblems(t.expr), [], `${d.file}: ${p.title}: ${t.expr}`);
        for (const [, label] of t.legendFormat.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) assert.ok(!FORBIDDEN_LABELS.includes(label), `${d.file}: legend ${label}`);
      }
    }
    assert.doesNotMatch(JSON.stringify(d), /tenant|business_id|\$\{?(business|tenant|shop|user)/i, `${d.file} has nothing per business`);
  }
  const text = (name) => JSON.stringify(dashboards.find((d) => d.file === name));
  for (const [name, needles] of [
    ['platform-overview.json', ['probe_success', 'http_requests_total', 'backup_age_seconds', 'businesses']],
    ['webhooks-and-queue.json', ['webhook_received_total', 'queue_jobs', 'queue_oldest_job_seconds', 'job_runs_total']],
    ['sending-and-compliance.json', ['compliance_outcomes_total', 'meta_calls_total', 'meta_usage_ratio', 'sends_accepted_total']],
    ['store-and-payments.json', ['razorpay_billing', 'shiprocket', 'provider_calls_total']],
    ['database-and-runtime.json', ['db_pool_connections', 'secret_refresh_failures_total', 'probe_ssl_earliest_cert_expiry', 'container_memory_working_set_bytes']],
  ]) for (const needle of needles) assert.ok(text(name).includes(needle), `${name} shows ${needle}`);
});

test('G-07: a dashboard that names an unknown metric or a per-business label is caught', () => {
  assert.notDeepEqual(expressionProblems('sum by (tenant) (rate(http_requests_total[5m]))'), []);
  assert.notDeepEqual(expressionProblems('sum(rate(business_orders_total[5m]))'), []);
  assert.ok(FORBIDDEN_LABELS.includes('tenant') && FORBIDDEN_LABELS.includes('business'));
});

// ---- Alertmanager --------------------------------------------------------------------------------------------------------------

const am = readYaml('alertmanager.yaml');
const BOUNDED_GROUPING = new Set(['alertname', 'severity', 'area', 'instance', 'job', 'pod', 'probe', ...Object.keys(METRIC_LABELS)]);

/** The route an alert takes: the first child whose matchers hold, else the parent. */
function routeOf(labels, route = am.route, inherited = {}) {
  const here = { group_by: route.group_by ?? inherited.group_by, receiver: route.receiver ?? inherited.receiver, path: [...(inherited.path ?? []), route] };
  const holds = (matcher) => {
    const [, label, op, value] = /^(\w+)(=~|!~|!=|=)"(.*)"$/.exec(matcher);
    const have = labels[label] ?? '';
    return op === '=' ? have === value : op === '!=' ? have !== value : op === '=~' ? new RegExp(`^(?:${value})$`).test(have) : !new RegExp(`^(?:${value})$`).test(have);
  };
  for (const child of route.routes ?? []) if ((child.matchers ?? []).every(holds)) return routeOf(labels, child, here);
  return here;
}
const groupKey = (labels) => {
  const r = routeOf(labels);
  return `${r.receiver}|${r.group_by.map((g) => `${g}=${labels[g] ?? ''}`).join(',')}`;
};
const inhibited = (alerts) => am.inhibit_rules.flatMap((rule) => {
  const holds = (matchers, labels) => matchers.every((m) => {
    const [, label, op, value] = /^(\w+)(=~|=)"(.*)"$/.exec(m);
    return op === '=' ? (labels[label] ?? '') === value : new RegExp(`^(?:${value})$`).test(labels[label] ?? '');
  });
  return alerts.filter((target) => holds(rule.target_matchers, target)
    && alerts.some((source) => source !== target && holds(rule.source_matchers, source) && rule.equal.every((l) => (source[l] ?? '') === (target[l] ?? ''))));
});

test('G-06: alerts go by severity: page to the page receiver, ticket to the ticket one, anything else to the ticket one', () => {
  assert.deepEqual(am.receivers.map((r) => r.name).sort(), ['page', 'ticket']);
  for (const rule of rules) {
    const r = routeOf({ alertname: rule.alert, severity: rule.labels.severity, area: rule.labels.area });
    assert.equal(r.receiver, rule.labels.severity, rule.alert);
  }
  assert.equal(routeOf({ alertname: 'Whatever' }).receiver, 'ticket', 'the default is the quieter receiver');
  const page = routeOf({ severity: 'page' }).path.at(-1);
  const ticket = routeOf({ severity: 'ticket' }).path.at(-1);
  assert.ok(parseDuration(page.group_wait) <= 60_000 && parseDuration(page.repeat_interval) <= 3_600_000 * 4, 'a page is sent quickly and repeated often');
  assert.ok(parseDuration(ticket.repeat_interval) >= parseDuration(page.repeat_interval), 'a ticket repeats less often than a page');
});

test('G-06: the receivers are placeholders: no address, key, token or webhook URL in the file, only paths of files the deploy mounts', () => {
  for (const receiver of am.receivers) {
    assert.ok(receiver.webhook_configs?.length >= 1);
    for (const c of receiver.webhook_configs) {
      assert.deepEqual(Object.keys(c).sort(), ['send_resolved', 'url_file']);
      assert.match(c.url_file, /^\/etc\/alertmanager\/destinations\/(page|ticket)$/);
      assert.equal(c.send_resolved, true);
    }
  }
  const text = fs.readFileSync(path.join(MONITORING, 'alertmanager.yaml'), 'utf8');
  for (const bad of [/https?:\/\//i, /@[\w-]+\.\w+/, /\bhooks\.slack\b/i, /\bapi[_-]?key\b\s*:/i, /\btoken\b\s*:/i, /\bpassword\b\s*:/i, /\bsmtp\b/i, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, /routing_key|service_key|bot_token|auth_token/i]) assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), bad);
});

test('G-06: an alert storm is grouped by alert, so one alert\'s flood is one notification and never folds into, or hides, another', () => {
  for (const route of [am.route, ...am.route.routes]) assert.equal(route.group_by[0], 'alertname', 'every route groups by alert first');
  for (const g of [...am.route.group_by, ...am.route.routes.flatMap((r) => r.group_by)]) assert.ok(BOUNDED_GROUPING.has(g), `${g} is a bounded label`);
  assert.ok(![...am.route.group_by, ...am.route.routes.flatMap((r) => r.group_by)].some((g) => FORBIDDEN_LABELS.includes(g)));
  assert.ok(!JSON.stringify(am.route).includes('...'), 'never grouped by every label');
  // A hundred pods of one business's trouble, as the same alert from different instances: one group.
  const flood = Array.from({ length: 100 }, (_, i) => ({ alertname: 'SendsFailing', severity: 'page', area: 'sending', channel: 'instagram', instance: `web-${i}` }));
  assert.equal(new Set(flood.map(groupKey)).size, 1, 'a flood of one alert is one notification');
  // Beside it a different alert, a different channel of the same alert, and a queue alert: each its own group.
  const others = [
    { alertname: 'WebhookIntakeFailing', severity: 'page', area: 'webhooks', provider: 'meta', instance: 'web-1' },
    { alertname: 'SendsFailing', severity: 'page', area: 'sending', channel: 'whatsapp', instance: 'web-1' },
    { alertname: 'QueueStuck', severity: 'page', area: 'queue', queue: 'dm.send' },
    { alertname: 'QueueStuck', severity: 'page', area: 'queue', queue: 'webhooks.meta' },
  ];
  const keys = new Set([...flood, ...others].map(groupKey));
  assert.equal(keys.size, 1 + others.length, 'four more groups beside the flood\'s');
  assert.equal(new Set(others.map(groupKey)).size, others.length);
  // The ticket flood is grouped the same way, and slower.
  assert.equal(new Set(Array.from({ length: 50 }, (_, i) => ({ alertname: 'ErrorReportsSpiking', severity: 'ticket', area: 'runtime', kind: 'orders', instance: `w-${i}` })).map(groupKey)).size, 1);
});

test('G-06: inhibition is by named pairs that share a label, so a page never hides an unrelated alert, nor another queue\'s', () => {
  const names = new Set(rules.map((r) => r.alert));
  assert.ok(am.inhibit_rules.length >= 3);
  for (const rule of am.inhibit_rules) {
    assert.ok(rule.equal?.length >= 1, 'a rule with no equal label would hide everything of the target kind');
    for (const m of [...rule.source_matchers, ...rule.target_matchers]) {
      const found = /^alertname(=~?)"(.*)"$/.exec(m);
      assert.ok(found, `${m} names an alert`);
      for (const n of found[2].split('|')) assert.ok(names.has(n), `${n} is a rule`);
    }
    const source = rules.find((r) => rule.source_matchers[0].includes(r.alertname ?? r.alert));
    assert.equal(source.labels.severity, 'page', 'only a page hides something');
  }
  const stuck = { alertname: 'QueueStuck', severity: 'page', area: 'queue', queue: 'dm.send' };
  const oldSame = { alertname: 'QueueOldestJobTooOld', severity: 'ticket', area: 'queue', queue: 'dm.send' };
  const oldOther = { alertname: 'QueueOldestJobTooOld', severity: 'ticket', area: 'queue', queue: 'webhooks.meta' };
  const unrelated = [{ alertname: 'SendsHeld', severity: 'ticket', area: 'sending', channel: 'instagram' }, { alertname: 'MemoryNearLimit', severity: 'ticket', area: 'runtime', pod: 'web-1' }, { alertname: 'MetaUsageHigh', severity: 'ticket', area: 'sending', call_class: 'send' }];
  const hidden = inhibited([stuck, oldSame, oldOther, ...unrelated]);
  assert.deepEqual(hidden, [oldSame], 'only the same queue\'s lesser alert is hidden');
  assert.deepEqual(inhibited([{ alertname: 'MetaUsageCritical', severity: 'page', call_class: 'send' }, { alertname: 'MetaUsageHigh', severity: 'ticket', call_class: 'read' }]), [], 'another class stays visible');
  assert.equal(inhibited([{ alertname: 'UptimeBurnFast', severity: 'page', probe: 'webhook' }, { alertname: 'UptimeBurnTicket', severity: 'ticket', probe: 'webhook' }, { alertname: 'UptimeBurnTicket', severity: 'ticket', probe: 'shopper_page' }]).length, 1);
});

// ---- The probe -------------------------------------------------------------------------------------------------------------------

test('G-13: the outside probe checks the webhook address and a shopper page, from outside, over TLS, with placeholders for every address', () => {
  const blackbox = readYaml('probe/blackbox.yaml');
  assert.deepEqual(Object.keys(blackbox.modules).sort(), [...UPTIME_SLO.probes].sort());
  for (const [name, m] of Object.entries(blackbox.modules)) {
    assert.equal(m.prober, 'http', name);
    assert.equal(m.http.fail_if_not_ssl, true, `${name} over TLS`);
    assert.equal(m.http.no_follow_redirects, true, `${name} does not follow a redirect to somewhere that works`);
    assert.ok(parseDuration(m.timeout) <= 15_000);
  }
  assert.deepEqual(blackbox.modules.webhook.http.valid_status_codes, [403], 'the webhook answers 403 without Meta\'s token, which proves it is up');
  assert.deepEqual(blackbox.modules.shopper_page.http.valid_status_codes, [200]);

  const scrape = readYaml('probe/scrape.yaml').scrape_configs;
  const probes = scrape.filter((j) => j.metrics_path === '/probe');
  assert.deepEqual(probes.flatMap((j) => j.static_configs.map((s) => s.labels.probe)).sort(), [...UPTIME_SLO.probes].sort(), 'each objective has a probe job labelled for it');
  for (const job of probes) {
    assert.ok(job.relabel_configs.some((r) => r.target_label === '__param_target'));
    assert.ok(job.relabel_configs.some((r) => r.target_label === '__address__' && /^PROBE_EXPORTER_ADDRESS/.test(r.replacement)));
  }
  const targets = scrape.flatMap((j) => j.static_configs.flatMap((s) => s.targets));
  assert.ok(targets.every((t) => /PLATFORM_HOST_|PROBE_EXPORTER/.test(t)), 'every address is a placeholder');
  for (const job of scrape.filter((j) => j.metrics_path === '/metrics')) {
    assert.equal(job.authorization.type, 'Bearer');
    assert.match(job.authorization.credentials_file, /^\/etc\/prometheus\/secrets\//, `${job.job_name}: the token is read from a file`);
    assert.equal(job.scheme, 'https');
  }
  assert.deepEqual(scrape.filter((j) => j.metrics_path === '/metrics').map((j) => j.job_name).sort(), ['web', 'worker']);
  const text = fs.readFileSync(path.join(MONITORING, 'probe/scrape.yaml'), 'utf8') + fs.readFileSync(path.join(MONITORING, 'probe/blackbox.yaml'), 'utf8');
  assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|bearer_token:|password:/);
});

test('monitoring files hold no address, key or token: nothing a public repository should not have', () => {
  const all = [];
  const walkDir = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walkDir(path.join(dir, e.name)) : all.push(path.join(dir, e.name))));
  walkDir(MONITORING);
  assert.ok(all.length >= 20);
  for (const file of all) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${path.basename(file)} has an IP address`);
    assert.doesNotMatch(text, /(rzp_(live|test)_|EAA[A-Za-z0-9]{10}|sk_(live|test)_|AKIA[A-Z0-9]{12}|-----BEGIN)/, `${path.basename(file)} has a key`);
  }
});
