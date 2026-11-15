// G-06, G-07 and G-13 (PRD 11: availability, observability): alert rules, dashboards, the outside probe and the metrics the
// running app serves. Attack cases: a rule or dashboard naming a metric that does not exist, or a label the metric does not
// have; a label that names a business; a metric label carrying an id (a flood of different addresses must not make a flood
// of series); an alert that fires but never clears; burn rates that do not match the objective; a secret in a route file.
// The rule unit tests run under promtool when it is installed; otherwise that part is reported as needing CI.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { EXTERNAL_METRICS, FORBIDDEN_LABELS, LABEL_OVERRIDES, METRICS, METRIC_LABELS, UPTIME_SLO, metricProblem, metricSeriesNames } from '../../../src/contracts/metrics.js';
import { startApp } from '../../helpers.js';
import { ROOT, exists, hasTool, needsCi, read } from './support.js';

const MON = 'deploy/prod/monitoring';
const files = (dir, re) => (exists(dir) ? fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`) : []);
const ruleFiles = () => files(`${MON}/rules`, /\.ya?ml$/);
const testFiles = () => files(`${MON}/rules/tests`, /\.ya?ml$/);
const dashboardFiles = () => files(`${MON}/dashboards`, /\.json$/);
const loadYaml = (rel) => yaml.load(read(rel));

const KEYWORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset', 'and', 'or', 'unless', 'inf', 'nan', 'atan2', 'start', 'end', 'as', 'with']);
/** The metric names an expression reads (a heuristic over PromQL: names not followed by a bracket, outside label sets and by-clauses). */
export function metricNamesIn(expr) {
  let s = String(expr).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""');
  s = s.replace(/\{[^}]*\}/g, (m) => `{${m.length}}`).replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const names = [];
  for (const m of s.matchAll(/(?<![\w.:])([A-Za-z_:][A-Za-z0-9_:]*)(?!\w)/g)) {
    const after = s.slice(m.index + m[1].length).trimStart();
    if (after.startsWith('(')) continue;
    if (KEYWORDS.has(m[1])) continue;
    if (/^\{\d+\}$/.test(m[1])) continue;
    names.push(m[1]);
  }
  return names;
}
/** The label names an expression uses in selectors and by-clauses. */
export function labelNamesIn(expr) {
  const out = new Set();
  for (const m of String(expr).matchAll(/\{([^}]*)\}/g)) for (const l of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)/g)) out.add(l[1]);
  for (const m of String(expr).matchAll(/\b(?:by|without|on|ignoring)\s*\(([^)]*)\)/g)) for (const l of m[1].split(',')) if (l.trim()) out.add(l.trim());
  return [...out];
}
const labelsOf = (name) => {
  const base = name.replace(/_(bucket|sum|count)$/, '');
  const def = METRICS[name] ?? METRICS[base];
  if (!def) return null;
  return new Set([...def.labels, ...(def.type === 'histogram' ? ['le'] : [])]);
};
const ALWAYS = new Set(['job', 'instance', 'alertname', 'severity', 'alertstate', '__name__', 'le', 'probe', 'target', 'service', 'pod', 'namespace', 'container']);

function ruleDefs() {
  const out = [];
  for (const file of ruleFiles()) {
    const doc = loadYaml(file);
    for (const group of doc?.groups ?? []) for (const rule of group.rules ?? []) out.push({ file, group: group.name, ...rule });
  }
  return out;
}
const recorded = () => new Set(ruleDefs().filter((r) => r.record).map((r) => r.record));

function checkExpr(label, expr, known, problems) {
  for (const name of metricNamesIn(expr)) {
    if (!known.has(name) && !recorded().has(name)) problems.push(`${label}: names ${name}, which is not a metric`);
  }
  for (const m of String(expr).matchAll(/([A-Za-z_:][A-Za-z0-9_:]*)\s*\{([^}]*)\}/g)) {
    const allowed = labelsOf(m[1]);
    if (!allowed) continue;
    for (const l of m[2].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)/g)) {
      if (!allowed.has(l[1]) && !ALWAYS.has(l[1]) && l[1] !== 'status' && l[1] !== 'state') problems.push(`${label}: ${m[1]} has no label ${l[1]}`);
      if (FORBIDDEN_LABELS.includes(l[1])) problems.push(`${label}: filters on ${l[1]}`);
    }
  }
  for (const l of labelNamesIn(expr)) if (FORBIDDEN_LABELS.includes(l)) problems.push(`${label}: groups or filters by ${l}`);
}

// ---- the checker sees what it should --------------------------------------------------------------------------------------

test('G-06: the check itself catches a metric that does not exist and a label the metric does not have', () => {
  const known = metricSeriesNames();
  const bad = [];
  checkExpr('x', 'sum(rate(orders_total[5m])) > 1', known, bad);
  checkExpr('y', 'sum by (tenant) (rate(http_requests_total[5m]))', known, bad);
  checkExpr('z', 'http_requests_total{business="x"}', known, bad);
  assert.ok(bad.some((p) => /orders_total/.test(p)) && bad.some((p) => /tenant/.test(p)) && bad.some((p) => /business/.test(p)), bad.join('\n'));
  const fine = [];
  checkExpr('ok', 'sum(rate(http_requests_total{group="webhook",status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05 and histogram_quantile(0.99, sum by (le) (rate(http_request_seconds_bucket[5m]))) > 2', known, fine);
  assert.deepEqual(fine, []);
});

// ---- G-06 ----------------------------------------------------------------------------------------------------------------

test('G-06: there are alert rules, each with a severity of page or ticket, a summary and an expression', () => {
  assert.ok(ruleFiles().length > 0, 'no rule file under deploy/prod/monitoring/rules');
  const alerts = ruleDefs().filter((r) => r.alert);
  assert.ok(alerts.length >= 12, `${alerts.length} alerts`);
  assert.equal(new Set(alerts.map((a) => a.alert)).size, alerts.length, 'alert names are unique');
  for (const a of alerts) {
    assert.match(a.alert, /^[A-Z][A-Za-z0-9]+$/, a.alert);
    assert.ok(['page', 'ticket'].includes(a.labels?.severity), `${a.alert}: severity`);
    assert.ok(a.annotations?.summary, `${a.alert}: a summary`);
    assert.ok(String(a.expr ?? '').trim(), `${a.alert}: an expression`);
  }
});

test('G-06: every metric an alert rule or a recording rule reads exists, with only labels it has, and no label names a business', () => {
  const known = metricSeriesNames();
  assert.ok(ruleFiles().length > 0, 'no rule file');
  const problems = [];
  for (const r of ruleDefs()) checkExpr(`${r.file} ${r.alert ?? r.record}`, r.expr, known, problems);
  assert.deepEqual(problems, []);
  const text = ruleFiles().map(read).join('\n');
  for (const name of FORBIDDEN_LABELS) assert.equal(new RegExp(`\\b${name}\\s*(=|=~|!=)|by\\s*\\([^)]*\\b${name}\\b`).test(text), false, `a rule uses ${name}`);
});

test('G-06: the rules cover the failures the platform cares about', () => {
  const alerts = ruleDefs().filter((r) => r.alert);
  const covered = (...names) => alerts.some((a) => names.some((n) => String(a.expr).includes(n)));
  const need = {
    'webhook intake': ['webhook_received_total', 'webhook_processed_total', 'webhook_stored_total'],
    'queue growth or age': ['queue_oldest_job_seconds', 'queue_jobs'],
    'job failures': ['job_failures_total', 'job_runs_total'],
    'sends failing or held': ['compliance_outcomes_total', 'sends_accepted_total'],
    'Meta throttling or token failures': ['meta_usage_ratio', 'meta_calls_total'],
    'payment and courier providers': ['provider_calls_total'],
    'backup too old': ['backup_age_seconds', 'backup_last_success_seconds'],
    'database connections': ['db_pool_connections'],
    'error rate': ['errors_reported_total', 'http_requests_total'],
    'certificate expiry': ['probe_ssl_earliest_cert_expiry'],
    'secret refresh failing': ['secret_refresh_failures_total'],
    'a target down': ['up'],
    'the outside probe': ['probe_success'],
  };
  const missing = Object.entries(need).filter(([, names]) => !covered(...names)).map(([what]) => what);
  assert.deepEqual(missing, [], 'no alert covers these');
});

test('G-06: each alert has a unit test where it fires and then clears', () => {
  const alerts = ruleDefs().filter((r) => r.alert).map((r) => r.alert);
  assert.ok(testFiles().length > 0, 'no rule test under rules/tests');
  const cases = new Map();
  for (const file of testFiles()) {
    const doc = loadYaml(file);
    for (const t of doc?.tests ?? []) {
      for (const c of t.alert_rule_test ?? []) {
        const list = cases.get(c.alertname) ?? [];
        list.push({ at: String(c.eval_time), fired: (c.exp_alerts ?? []).length > 0 });
        cases.set(c.alertname, list);
      }
    }
  }
  const lacking = [];
  for (const name of alerts) {
    const list = cases.get(name) ?? [];
    const firedAt = list.findIndex((c) => c.fired);
    if (firedAt === -1) lacking.push(`${name}: never expected to fire`);
    else if (!list.slice(firedAt + 1).some((c) => !c.fired) && !list.slice(0, firedAt).some((c) => !c.fired)) lacking.push(`${name}: never expected to be quiet`);
  }
  assert.deepEqual(lacking, []);
  const known = new Set(alerts);
  assert.deepEqual([...cases.keys()].filter((n) => !known.has(n)), [], 'a test for an alert that does not exist');
});

test('G-06: promtool accepts the rules and every rule test passes', { skip: hasTool('promtool') ? false : needsCi('promtool') }, async () => {
  const run = (args) => new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const c = spawn('promtool', args, { cwd: ROOT });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('close', (code) => resolve({ code, out }));
    });
  });
  const check = await run(['check', 'rules', ...ruleFiles()]);
  assert.equal(check.code, 0, check.out);
  const tests = await run(['test', 'rules', ...testFiles()]);
  assert.equal(tests.code, 0, tests.out);
});

test('G-06: a route file holds severities page and ticket, receivers that are placeholders, and no address, key or person', () => {
  const file = `${MON}/alertmanager.yaml`;
  assert.ok(exists(file), 'alertmanager.yaml');
  const doc = loadYaml(file);
  const text = read(file);
  const routes = JSON.stringify(doc.route ?? {});
  assert.ok(/page/.test(routes) && /ticket/.test(routes), 'routes by severity');
  const receivers = new Set((doc.receivers ?? []).map((r) => r.name));
  for (const name of [...routes.matchAll(/"receiver":"([^"]+)"/g)].map((m) => m[1])) assert.ok(receivers.has(name), `route to ${name}, which is not a receiver`);
  assert.equal(/https?:\/\//.test(text.replace(/^\s*#.*$/gm, '')), false, 'no address in the file');
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), false, 'no email address');
  assert.equal(/(api_key|auth_token|password|routing_key|service_key|bot_token)\s*:\s*['"]?[A-Za-z0-9]{12,}/i.test(text), false, 'no key');
  assert.equal(/\+?\d{10,}/.test(text), false, 'no phone number');
});

// ---- G-07 ----------------------------------------------------------------------------------------------------------------

test('G-07: there are dashboards, each valid JSON with panels that query', () => {
  const list = dashboardFiles();
  assert.ok(list.length >= 5, `${list.length} dashboards`);
  for (const file of list) {
    const doc = JSON.parse(read(file));
    assert.ok(doc.title && Array.isArray(doc.panels ?? doc.rows), `${file}: a title and panels`);
    const exprs = collectExprs(doc);
    assert.ok(exprs.length > 0, `${file}: at least one query`);
  }
});

function collectExprs(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectExprs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'expr' || k === 'expression') && typeof v === 'string') out.push(v);
      else collectExprs(v, out);
    }
  }
  return out;
}

test('G-07: every metric a dashboard names exists, with labels it has, and no dashboard filters or groups by a business', () => {
  const known = metricSeriesNames();
  assert.ok(dashboardFiles().length > 0, 'no dashboard');
  const problems = [];
  for (const file of dashboardFiles()) {
    const doc = JSON.parse(read(file));
    for (const expr of collectExprs(doc)) checkExpr(file, expr.replace(/\$\{?[A-Za-z_]+\}?/g, '1'), known, problems);
    const variables = (doc.templating?.list ?? []).map((v) => `${v.name} ${JSON.stringify(v.query ?? '')} ${v.label ?? ''}`);
    for (const v of variables) for (const bad of FORBIDDEN_LABELS) assert.equal(new RegExp(`\\b${bad}\\b`, 'i').test(v), false, `${file}: a variable on ${bad}`);
  }
  assert.deepEqual(problems, []);
});

test('G-07: a dashboard holds no address, token or person', () => {
  assert.ok(dashboardFiles().length > 0, 'no dashboard');
  for (const file of dashboardFiles()) {
    const text = read(file);
    assert.equal(/(eyJ[A-Za-z0-9_-]{20,}|glsa_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._-]{12,})/.test(text), false, `${file}: a token`);
    assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), false, `${file}: an email address`);
  }
});

// ---- G-13 ----------------------------------------------------------------------------------------------------------------

test('G-13: the objective is 99.5% over 30 days and each burn rate has an alert with its windows, factor and severity', () => {
  assert.deepEqual([UPTIME_SLO.objective, UPTIME_SLO.windowDays], [0.995, 30]);
  const alerts = ruleDefs().filter((r) => r.alert && /probe_success|slo|burn/i.test(`${r.expr} ${r.alert}`));
  assert.ok(alerts.length >= UPTIME_SLO.burnAlerts.length, 'one alert for each burn rate');
  for (const burn of UPTIME_SLO.burnAlerts) {
    const match = alerts.find((a) => String(a.expr).includes(`[${burn.longWindow}]`) && String(a.expr).includes(`[${burn.shortWindow}]`) && String(a.expr).includes(String(burn.burnRate)));
    assert.ok(match, `no alert for ${burn.longWindow}/${burn.shortWindow} at ${burn.burnRate}x`);
    assert.equal(match.labels.severity, burn.severity, `${match.alert}: severity`);
    assert.ok(/0\.005|\(1\s*-\s*0\.995\)/.test(match.expr) || /0\.995/.test(match.expr), `${match.alert}: the error budget is 1 - 0.995`);
    assert.ok(String(match.expr).includes('probe_success'), `${match.alert}: reads the outside probe`);
  }
});

test('G-13: the outside probe watches the webhook address and a shopper page, only over https, with no credential and no business named', () => {
  const dir = `${MON}/probe`;
  const list = files(dir, /\.(ya?ml|json)$/);
  assert.ok(list.length > 0, 'no probe configuration under monitoring/probe');
  const text = list.map(read).join('\n');
  assert.ok(/webhook/i.test(text), 'a webhook target');
  assert.ok(/shopper|store|shop|page/i.test(text), 'a shopper page target');
  for (const url of text.match(/https?:\/\/[^\s"',)]+/g) ?? []) {
    assert.ok(url.startsWith('https://'), `${url}: plain http`);
    assert.equal(/\/\/[^/@]+@/.test(url), false, 'a login in an address');
  }
  assert.equal(/(bearer|authorization|api[_-]?key|password|token)\s*[:=]\s*['"]?[A-Za-z0-9]{10,}/i.test(text), false, 'a credential');
});

test('G-13: the paths the probe asks for answer on the running app without a server error', async () => {
  const list = files(`${MON}/probe`, /\.(ya?ml|json)$/);
  assert.ok(list.length > 0, 'no probe configuration');
  const text = list.map(read).join('\n');
  const paths = [...new Set([...text.matchAll(/https?:\/\/[^/\s"']+(\/[A-Za-z0-9_\-./?=&%]*)/g)].map((m) => m[1]))].filter((p) => p !== '/');
  assert.ok(paths.length > 0, 'the probe config names a path');
  const app = await startApp();
  try {
    for (const p of paths) {
      const res = await fetch(`${app.base}${p.replace(/\{\{[^}]*\}\}|\$\{[^}]*\}/g, 'x')}`);
      assert.ok(res.status < 500, `${p} answered ${res.status}`);
    }
  } finally {
    app.close();
  }
});

// ---- the metrics the app serves --------------------------------------------------------------------------------------------

const apps = [];
after(async () => {
  for (const close of apps.reverse()) await close();
});

function parseSeries(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels = Object.fromEntries([...(m[2] ?? '').matchAll(/([A-Za-z_]\w*)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    out.push({ name: m[1], labels, value: m[3] });
  }
  return out;
}

async function scrape(app, token = 'metrics-token-for-spec-0123456789') {
  const res = await fetch(`${app.base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, text: await res.text() };
}

test('G-06: every series the app serves is in the catalogue, with bounded label names, and none names a business or a person', async () => {
  const app = await startApp({ overrides: { metricsToken: 'metrics-token-for-spec-0123456789' } });
  apps.push(() => app.close());
  await app.platform.tenants.create({ slug: 'leaky-slug-shop', name: 'Leaky Name Shop', plan: 't3' });
  for (const p of ['/', '/healthz', '/nope', '/leaky-slug-shop', '/api/v1/me', '/login']) await fetch(`${app.base}${p}`, { headers: { 'x-forwarded-host': 'leaky-slug-shop.bhava.test' } });
  const { status, text } = await scrape(app);
  assert.equal(status, 200);
  const series = parseSeries(text);
  assert.ok(series.length > 0);
  const problems = [];
  for (const s of series) {
    const base = s.name.replace(/_(bucket|sum|count)$/, '');
    const name = METRICS[s.name] ? s.name : base;
    const { le, ...labels } = s.labels;
    const problem = metricProblem(name, labels);
    if (problem) problems.push(`${s.name}: ${problem}`);
  }
  assert.deepEqual([...new Set(problems)], []);
  assertNoneOfText(text, ['leaky-slug-shop', 'Leaky Name Shop', 'shopper_handle']);
});

function assertNoneOfText(text, needles) {
  for (const n of needles) assert.equal(text.includes(n), false, `/metrics shows ${n}`);
}

test('G-06: a flood of different addresses, hosts and statuses does not make a flood of series: every label stays inside its declared ceiling', async () => {
  const app = await startApp({ overrides: { metricsToken: 'metrics-token-for-spec-0123456789' } });
  apps.push(() => app.close());
  for (let i = 0; i < 140; i++) {
    const word = `shop${[i % 26, Math.floor(i / 26) % 26, Math.floor(i / 676)].map((n) => String.fromCharCode(97 + n)).join('')}`;
    await fetch(`${app.base}/${word}/x?phone=98765${i}`, { headers: { 'x-forwarded-host': `${word}.bhava.test` } });
  }
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) await fetch(`${app.base}/some-path`, { method });
  const { text } = await scrape(app);
  const series = parseSeries(text);
  const distinct = (label) => new Set(series.filter((s) => label in s.labels).map((s) => s.labels[label]));
  for (const label of ['group', 'status', 'queue', 'method']) {
    const rule = METRIC_LABELS[label];
    const ceiling = rule.values ? rule.values.length : rule.max;
    assert.ok(distinct(label).size <= ceiling, `${label} has ${distinct(label).size} values, ceiling ${ceiling}`);
  }
  assert.ok(distinct('group').size <= 80);
  const shopGroups = [...distinct('group')].filter((g) => /^shop-\d+$/.test(g));
  assert.deepEqual(shopGroups, [], 'a business-like first path segment became a label value');
  assert.ok(series.length < 1500, `${series.length} series after a flood`);
  assertNoneOfText(text, ['98765']);
});

test('G-06: /metrics answers only with the token, and a wrong or empty token learns nothing', async () => {
  const app = await startApp({ overrides: { metricsToken: 'metrics-token-for-spec-0123456789' } });
  apps.push(() => app.close());
  const none = await fetch(`${app.base}/metrics`);
  const wrong = await fetch(`${app.base}/metrics`, { headers: { authorization: 'Bearer wrong-token-of-another-length' } });
  const same = await fetch(`${app.base}/metrics`, { headers: { authorization: 'Bearer metrics-token-for-spec-0123456780' } });
  for (const res of [none, wrong, same]) {
    assert.ok([401, 403, 404].includes(res.status), `a stranger got ${res.status}`);
    assert.equal((await res.text()).includes('# TYPE'), false);
  }
  const off = await startApp({ overrides: { metricsToken: '' } });
  apps.push(() => off.close());
  const open = await fetch(`${off.base}/metrics`, { headers: { authorization: 'Bearer ' } });
  assert.ok([401, 403, 404].includes(open.status), 'no token set: /metrics is hidden, not open');
});

test('G-06: the series the code is promised to emit are served after the work that makes them', async () => {
  const app = await startApp({ overrides: { metricsToken: 'metrics-token-for-spec-0123456789' } });
  apps.push(() => app.close());
  await fetch(`${app.base}/healthz`);
  const { text } = await scrape(app);
  const names = new Set(parseSeries(text).map((s) => s.name.replace(/_(bucket|sum|count)$/, '')));
  for (const must of ['http_requests_total', 'http_request_seconds', 'http_requests_in_flight', 'queue_jobs', 'process_draining', 'db_pool_connections']) {
    assert.ok(names.has(must), `${must} is not served`);
  }
  const draining = parseSeries(text).filter((s) => s.name === 'process_draining');
  assert.ok(draining.every((s) => ['0', '1'].includes(s.value)) && draining.length > 0);
});

test('G-06: the contract\'s own label rules are met by the catalogue: no label of any metric is on the forbidden list or unbounded', () => {
  for (const [name, def] of Object.entries(METRICS)) {
    for (const label of def.labels) {
      assert.equal(FORBIDDEN_LABELS.includes(label), false, `${name}.${label}`);
      const rule = LABEL_OVERRIDES[name]?.[label] ?? METRIC_LABELS[label];
      assert.ok(rule && (rule.values || (rule.pattern && rule.max <= 100)), `${name}.${label} is bounded`);
    }
  }
  assert.deepEqual(EXTERNAL_METRICS.filter((n) => metricSeriesNames().has(n) === false), []);
});

test('G-06: a metric name outside the catalogue, or a label carrying an id, is named by metricProblem', () => {
  assert.match(metricProblem('orders_total', {}), /not in the catalogue/);
  assert.match(metricProblem('http_requests_total', { group: 'a-business-called-9f3c2a7e5b1d' }), /outside its set/);
  assert.match(metricProblem('http_requests_total', { status: 'abc' }), /outside its set/);
  assert.match(metricProblem('provider_calls_total', { provider: 'someones-shop' }), /outside its set/);
  assert.match(metricProblem('sends_accepted_total', { tenant_id: '7' }), /label tenant_id/);
});
