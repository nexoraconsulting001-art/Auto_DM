/**
 * The production templates validate (G-08; npm run prod:validate): the compose file, the Kubernetes manifests, the Terraform
 * templates and the monitoring rules, each with the tool that reads it, run from that tool's public container image.
 *
 *   compose_config        docker compose config on deploy/prod/compose (its example settings)
 *   kustomize_build       kustomize builds both overlays
 *   kubeconform           the built manifests are valid Kubernetes, strictly
 *   terraform_validate    fmt -check, init -backend=false, validate
 *   region_is_india_only  no file under deploy/prod names a region (they come from one variable); regions.json is India only
 *                         and is what the Terraform variable accepts
 *   promtool_check_rules  the alert rules are valid
 *   promtool_test_rules   every alert fires and clears in its unit tests
 *   dashboards_parse      each dashboard is JSON with a title, a unique id and panels that query
 *   metrics_exist         every rule and dashboard names only metrics the app emits (src/contracts/metrics.js)
 *
 * A step that needs docker is reported as skipped (not failed) on a machine that has none, with the reason; CI has docker, and
 * READINESS_STRICT=1 turns a skipped step into a failure. READINESS_SKIP_CONTAINERS=1 skips the docker steps because an earlier
 * step of the same job already ran each tool from its image. Nothing here deploys anything or reaches a cluster or a cloud account.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { EXTERNAL_METRICS, metricSeriesNames } from '../../src/contracts/metrics.js';
import { STEPS } from '../prod-checks/steps.mjs';
import { createReport } from '../prod-checks/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROD = path.join(ROOT, 'deploy', 'prod');

/** The tools by their public images. The workflow names the same ones. */
export const TOOL_IMAGES = Object.freeze({
  kustomize: 'registry.k8s.io/kustomize/kustomize:v5.4.3',
  kubeconform: 'ghcr.io/yannh/kubeconform:v0.6.7',
  terraform: 'hashicorp/terraform:1.9',
  promtool: 'prom/prometheus:v2.54.1',
});

/** Metrics that come from the cluster, not from the app. */
const CLUSTER_METRICS = Object.freeze(['container_memory_working_set_bytes', 'container_spec_memory_limit_bytes']);

const PROMQL_WORDS = new Set(['and', 'or', 'unless', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool', 'inf', 'nan', 'start', 'end']);

/** The metric names a PromQL expression (or a Grafana query) names: not functions, labels, durations or numbers. */
export function metricsIn(expression) {
  let text = String(expression ?? '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""')
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '1')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b\d[\w.]*/g, ' ');
  // Label matchers are inside braces; a metric name stands before them. Grouping lists follow by, without, on, ignoring, group_*.
  text = text.replace(/\{[^}]*\}/g, '').replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  const names = new Set();
  for (const match of text.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)) {
    const token = match[0];
    const after = text.slice(match.index + token.length).match(/^\s*(.)/)?.[1];
    if (after === '(' || PROMQL_WORDS.has(token) || /^\d/.test(token)) continue;
    names.add(token);
  }
  return [...names];
}

const walk = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/** Every `expr` (and every dashboard variable query) in a parsed dashboard, at any depth. */
export function dashboardExpressions(dashboard) {
  const out = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (typeof node.expr === 'string') out.push(node.expr);
    if (node.type === 'query' && typeof node.query === 'string') out.push(node.query.replace(/^label_values\(([^,)]+).*$/, '$1'));
    Object.values(node).forEach(visit);
  };
  visit(dashboard);
  return out;
}

const REGION_FOREIGN = /(^|[^a-z0-9-])(us|eu|ap|sa|ca|me|af)-(north|south|east|west|central|northeast|southeast)-\d([^a-z0-9-]|$)/;

export function regionProblems(prodDir = PROD) {
  const problems = [];
  const regions = JSON.parse(fs.readFileSync(path.join(prodDir, 'regions.json'), 'utf8'));
  if (regions.variable !== 'region') problems.push('regions.json does not name the one variable "region"');
  const india = regions.india ?? [];
  if (!india.length) problems.push('regions.json lists no India region');
  for (const file of walk(prodDir)) {
    if (path.basename(file) === 'regions.json') continue;
    const text = fs.readFileSync(file, 'utf8');
    const name = path.relative(prodDir, file).split(path.sep).join('/');
    const named = india.filter((r) => new RegExp(`(^|[^a-z0-9-])${r}([^a-z0-9-]|$)`).test(text));
    if (named.length) problems.push(`${name} names a region (${named[0]}): regions come from the one variable`);
    else if (REGION_FOREIGN.test(text)) problems.push(`${name} names a region outside India`);
  }
  const variables = path.join(prodDir, 'terraform', 'variables.tf');
  if (fs.existsSync(variables) && !/regions\.json/.test(fs.readFileSync(variables, 'utf8'))) problems.push('the Terraform region variable does not take its list from regions.json');
  return problems;
}

/** Runs a command; answers { code, out } with the last of its output. */
function exec(cmd, args, { cwd = ROOT, timeoutMs = 600_000, limit = 6000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const keep = (d) => { out = (out + d).slice(-limit); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => resolve({ code: -1, out: `${cmd} could not start` }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const firstError = (out) => String(out).split('\n').map((l) => l.trim()).filter((l) => /error|invalid|fail|not valid|unknown/i.test(l)).slice(0, 3).join(' | ') || String(out).trim().split('\n').at(-1) || 'no output';

export function dockerAvailable(run = spawnSync) {
  const r = run('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', windowsHide: true, timeout: 20_000 });
  return r.status === 0;
}

export async function run({ env = process.env, log = () => {}, runner = exec, docker = null } = {}) {
  const strict = env.READINESS_STRICT === '1';
  const report = createReport('validate', { steps: STEPS.validate });
  const haveDocker = docker ?? dockerAvailable();
  const skipContainers = env.READINESS_SKIP_CONTAINERS === '1';
  const container = (why) => ({ ok: !strict, skipped: true, detail: `skipped: ${why}${strict ? ' (READINESS_STRICT=1)' : ''}` });
  const needDocker = () => (skipContainers ? container('an earlier step of this job ran it from its public image') : !haveDocker ? container('docker is not on this machine; CI runs it from the tool\'s public image') : null);
  const mount = (host, target) => ['-v', `${host}:${target}:ro`];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-validate-'));

  try {
    await report.step('compose_config', async () => {
      const skip = needDocker();
      if (skip) return skip;
      const dir = path.join(PROD, 'compose');
      const r = await runner('docker', ['compose', '--env-file', '.env.example', '-f', 'compose.yaml', 'config', '-q'], { cwd: dir });
      return r.code === 0 ? 'docker compose config reads compose.yaml with its example settings' : { problems: [`docker compose config failed: ${firstError(r.out)}`] };
    });

    const built = [];
    await report.step('kustomize_build', async () => {
      const skip = needDocker();
      if (skip) return skip;
      const problems = [];
      for (const overlay of ['production', 'production-migrate']) {
        const out = path.join(tmp, `${overlay}.yaml`);
        const build = await runner('docker', ['run', '--rm', ...mount(path.join(PROD, 'k8s'), '/k8s'), TOOL_IMAGES.kustomize, 'build', `/k8s/overlays/${overlay}`], { limit: 64 * 1024 * 1024 });
        if (build.code !== 0) problems.push(`kustomize could not build overlays/${overlay}: ${firstError(build.out)}`);
        else {
          fs.writeFileSync(out, build.out);
          built.push(out);
        }
      }
      return problems.length ? { problems } : 'both overlays (production, production-migrate) build';
    });

    await report.step('kubeconform', async () => {
      const skip = needDocker();
      if (skip) return skip;
      if (!built.length) return { problems: ['there is no built manifest to check (the build step did not produce one)'] };
      const problems = [];
      for (const file of built) {
        const check = await runner('docker', ['run', '--rm', ...mount(path.dirname(file), '/m'), TOOL_IMAGES.kubeconform, '-strict', '-summary', `/m/${path.basename(file)}`], {});
        if (check.code !== 0) problems.push(`kubeconform rejects ${path.basename(file)}: ${firstError(check.out)}`);
      }
      return problems.length ? { problems } : `${built.length} built manifests are valid Kubernetes (strict)`;
    });

    await report.step('terraform_validate', async () => {
      const skip = needDocker();
      if (skip) return skip;
      const copy = path.join(tmp, 'terraform');
      fs.cpSync(path.join(PROD, 'terraform'), copy, { recursive: true });
      fs.copyFileSync(path.join(PROD, 'regions.json'), path.join(tmp, 'regions.json'));
      const base = ['run', '--rm', '-v', `${tmp}:/tf`, '-w', '/tf/terraform', TOOL_IMAGES.terraform];
      for (const args of [['fmt', '-check', '-recursive'], ['init', '-backend=false', '-input=false'], ['validate']]) {
        const r = await runner('docker', [...base, ...args], {});
        if (r.code !== 0) return { problems: [`terraform ${args[0]} failed: ${firstError(r.out)}`] };
      }
      return 'terraform fmt -check, init -backend=false and validate pass';
    });

    await report.step('region_is_india_only', async () => {
      const problems = regionProblems();
      return problems.length ? { problems } : 'regions.json lists India regions only, the Terraform variable takes its list, and no template names a region';
    });

    const monitoring = path.join(PROD, 'monitoring');
    await report.step('promtool_check_rules', async () => {
      const skip = needDocker();
      if (skip) return skip;
      const files = fs.readdirSync(path.join(monitoring, 'rules')).filter((f) => f.endsWith('.yaml')).map((f) => `/m/rules/${f}`);
      const r = await runner('docker', ['run', '--rm', ...mount(monitoring, '/m'), '--entrypoint', 'promtool', TOOL_IMAGES.promtool, 'check', 'rules', ...files], {});
      return r.code === 0 ? `promtool check rules passes for ${files.length} files` : { problems: [`promtool check rules failed: ${firstError(r.out)}`] };
    });

    await report.step('promtool_test_rules', async () => {
      const skip = needDocker();
      if (skip) return skip;
      const files = fs.readdirSync(path.join(monitoring, 'rules', 'tests')).filter((f) => f.endsWith('.yaml'));
      const r = await runner('docker', ['run', '--rm', ...mount(monitoring, '/m'), '-w', '/m/rules/tests', '--entrypoint', 'promtool', TOOL_IMAGES.promtool, 'test', 'rules', ...files], {});
      return r.code === 0 ? `promtool test rules passes for ${files.length} files: every alert fires and clears` : { problems: [`promtool test rules failed: ${firstError(r.out)}`] };
    });

    const dashboards = [];
    await report.step('dashboards_parse', async () => {
      const dir = path.join(monitoring, 'dashboards');
      const problems = [];
      const uids = new Set();
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        let json;
        try {
          json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch (err) {
          problems.push(`${file} is not JSON (${err.message.split('\n')[0]})`);
          continue;
        }
        dashboards.push({ file, json });
        if (!json.title) problems.push(`${file} has no title`);
        if (!json.uid) problems.push(`${file} has no uid`);
        else if (uids.has(json.uid)) problems.push(`${file} repeats the uid ${json.uid}`);
        uids.add(json.uid);
        const queries = dashboardExpressions(json).length;
        if (!Array.isArray(json.panels) || !json.panels.length) problems.push(`${file} has no panels`);
        else if (!queries) problems.push(`${file} has no query`);
      }
      if (!dashboards.length) problems.push('there is no dashboard');
      return problems.length ? { problems } : `${dashboards.length} dashboards parse, each with a title, a unique id and queries`;
    });

    await report.step('metrics_exist', async () => {
      const known = new Set([...metricSeriesNames(), ...EXTERNAL_METRICS, ...CLUSTER_METRICS]);
      const recorded = new Set();
      const rules = [];
      for (const file of fs.readdirSync(path.join(monitoring, 'rules')).filter((f) => f.endsWith('.yaml')).sort()) {
        const doc = yaml.load(fs.readFileSync(path.join(monitoring, 'rules', file), 'utf8'));
        for (const group of doc?.groups ?? []) for (const r of group.rules ?? []) {
          if (r.record) recorded.add(r.record);
          rules.push({ where: `${file} ${r.alert ?? r.record}`, expr: r.expr });
        }
      }
      for (const name of recorded) known.add(name);
      const problems = [];
      let count = 0;
      for (const { where, expr } of rules) {
        for (const name of metricsIn(expr)) {
          count++;
          if (!known.has(name)) problems.push(`${where} names ${name}, which the app does not emit`);
        }
      }
      for (const { file, json } of dashboards) {
        for (const expr of dashboardExpressions(json)) {
          for (const name of metricsIn(expr)) {
            count++;
            if (!known.has(name)) problems.push(`${file} names ${name}, which the app does not emit`);
          }
        }
      }
      return problems.length ? { problems } : `${count} metric names in ${rules.length} rules and ${dashboards.length} dashboards are all emitted by the app or the platform`;
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log('validate finished');
  return report.finish();
}
