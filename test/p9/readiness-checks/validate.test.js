// G-08 and G-13 to G-18 groundwork: the template validation (npm run prod:validate) and the production workflow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { READINESS_CHECKS } from '../../../tools/readiness/index.mjs';
import { TOOL_IMAGES, dashboardExpressions, metricsIn, regionProblems, run } from '../../../tools/readiness/validate.mjs';
import { read } from './support.js';

test('metricsIn reads the metric names of an expression and nothing else', () => {
  assert.deepEqual(metricsIn('sum by (queue) (queue_jobs{status="queued"}) > 500 and sum by (queue) (queue_jobs{status="queued"} offset 15m)'), ['queue_jobs']);
  assert.deepEqual(metricsIn('histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{code=~"5.."}[$__rate_interval]))) / on (route) group_left ignoring(code) up'), ['http_request_duration_seconds_bucket', 'up']);
  assert.deepEqual(metricsIn('1 - (a_total / b_total) > 0.05 unless c_gauge'), ['a_total', 'b_total', 'c_gauge']);
  assert.deepEqual(dashboardExpressions({ panels: [{ targets: [{ expr: 'up' }] }, { panels: [{ targets: [{ expr: 'rate(x_total[5m])' }] }] }], templating: { list: [{ type: 'query', query: 'label_values(up, job)' }] } }), ['up', 'rate(x_total[5m])', 'up']);
});

test('the templates in the repository pass the checks that need no container, and the ones that do are named as skipped, never passed silently', async () => {
  const report = await run({ docker: false, env: {} });
  assert.deepEqual(report.steps.map((s) => s.name), [...READINESS_CHECKS.validate.steps]);
  const failed = report.steps.filter((s) => !s.ok);
  assert.deepEqual(failed.map((s) => `${s.name}: ${s.detail}`), []);
  const local = report.steps.filter((s) => !s.skipped).map((s) => s.name);
  assert.deepEqual(local, ['region_is_india_only', 'dashboards_parse', 'metrics_exist']);
  for (const s of report.steps.filter((x) => x.skipped)) assert.match(s.detail, /^skipped: docker is not on this machine/);

  const strict = await run({ docker: false, env: { READINESS_STRICT: '1' } });
  assert.equal(strict.ok, false, 'with READINESS_STRICT a skipped step fails');
  assert.deepEqual(strict.steps.filter((s) => !s.ok).map((s) => s.name), ['compose_config', 'kustomize_build', 'kubeconform', 'terraform_validate', 'promtool_check_rules', 'promtool_test_rules']);
});

test('each container tool runs from its public image with the arguments the workflow uses, and a failing tool is named with what it said', async () => {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args.includes('kubeconform') || args.includes(TOOL_IMAGES.kubeconform)) return { code: 1, out: 'invalid: Deployment web is not valid: unknown field "foo"' };
    if (args.includes(TOOL_IMAGES.kustomize)) return { code: 0, out: 'kind: List\n' };
    return { code: 0, out: '' };
  };
  const report = await run({ docker: true, env: {}, runner });
  const by = Object.fromEntries(report.steps.map((s) => [s.name, s]));
  assert.equal(by.compose_config.ok, true);
  assert.equal(by.kustomize_build.ok, true);
  assert.equal(by.kubeconform.ok, false);
  assert.match(by.kubeconform.detail, /kubeconform rejects .*invalid: Deployment web is not valid/);
  assert.equal(by.terraform_validate.ok, true);
  assert.equal(by.promtool_check_rules.ok && by.promtool_test_rules.ok, true);
  const text = calls.join('\n');
  for (const image of Object.values(TOOL_IMAGES)) assert.ok(text.includes(image), image);
  assert.match(text, /docker compose --env-file \.env\.example -f compose\.yaml config -q/);
  assert.match(text, /terraform:1\.9 init -backend=false -input=false/);
  assert.match(text, /promtool prom\/prometheus:v2\.54\.1 check rules/);
  assert.match(text, /promtool prom\/prometheus:v2\.54\.1 test rules/);
  assert.match(text, /kustomize:v5\.4\.3 build \/k8s\/overlays\/production-migrate/);
  assert.equal(/--privileged|--network host|\/var\/run\/docker\.sock/.test(text), false, 'a tool runs with no extra privilege');
  assert.equal(/:\/[a-z0-9]+:ro/.test(text), true, 'the repository is mounted read-only where a tool only reads');
  // Every tool image in the table is the one the workflow names.
  const workflow = read('.github/workflows/prod.yml');
  for (const image of Object.values(TOOL_IMAGES)) assert.ok(workflow.includes(image.replace(/:v?[\d.]+$/, '')), image);
});

test('a template that names a region, or a region outside India, is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-regions-'));
  try {
    fs.mkdirSync(path.join(dir, 'terraform'));
    fs.writeFileSync(path.join(dir, 'regions.json'), JSON.stringify({ variable: 'region', india: ['ap-south-1', 'asia-south1'] }));
    fs.writeFileSync(path.join(dir, 'terraform', 'variables.tf'), 'validation { condition = contains(jsondecode(file("../regions.json")).india, var.region) }');
    fs.writeFileSync(path.join(dir, 'a.yaml'), 'ok: true');
    assert.deepEqual(regionProblems(dir), []);
    fs.writeFileSync(path.join(dir, 'b.yaml'), 'region: eu-west-1');
    fs.writeFileSync(path.join(dir, 'c.yaml'), 'bucket in ap-south-1');
    fs.writeFileSync(path.join(dir, 'terraform', 'variables.tf'), 'variable "region" {}');
    const problems = regionProblems(dir);
    assert.deepEqual(problems.sort(), ['b.yaml names a region outside India', 'c.yaml names a region (ap-south-1): regions come from the one variable', 'the Terraform region variable does not take its list from regions.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the production workflow builds both architectures, validates from public images, and runs the three checks on service containers with no secret', () => {
  const workflow = read('.github/workflows/prod.yml');
  for (const needle of ['linux/${{ matrix.arch }}', 'ubuntu-24.04-arm', 'npm run ${{ matrix.check }}', 'check:r05', 'check:r06', 'check:r07', 'npm run prod:validate', 'postgresql-client-16', 'minio/minio:RELEASE', 'tools/prod-checks/**']) {
    assert.ok(workflow.includes(needle), needle);
  }
  for (const image of Object.values(TOOL_IMAGES)) assert.ok(workflow.includes(image), `the workflow runs ${image}`);
  assert.equal(/secrets\./.test(workflow), false);
  assert.equal(/apt-get install[^\n]*(terraform|kubeconform|promtool|kustomize)/.test(workflow), false);
  assert.match(workflow, /timeout-minutes: 60/);
  // Each check finds its services by the settings the list names, and the job sets all of them.
  const needs = new Set(['r05', 'r06', 'r07'].flatMap((c) => READINESS_CHECKS[c].needs));
  for (const name of needs) assert.ok(workflow.includes(`${name}:`), `the job sets ${name}`);
  // The scripts the package.json runs are the ones in the list.
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const check of ['r05', 'r06', 'r07', 'validate']) assert.equal(scripts[check === 'validate' ? 'prod:validate' : `check:${check}`], `node tools/readiness/index.mjs ${check}`);
});
