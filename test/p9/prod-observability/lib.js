// What the monitoring tests share: where the files are, and the check that an expression names only catalogue metrics and labels.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { EXTERNAL_METRICS, FORBIDDEN_LABELS, METRICS, metricProblem, metricSeriesNames } from '../../../src/contracts/metrics.js';
import { repoRoot } from '../../../tools/gate-lib.mjs';
import { parse, walk } from './promql.js';

export const MONITORING = path.join(repoRoot, 'deploy/prod/monitoring');
export const readYaml = (file) => yaml.load(fs.readFileSync(path.join(MONITORING, file), 'utf8'));
export const files = (dir, ext) => fs.readdirSync(path.join(MONITORING, dir)).filter((f) => f.endsWith(ext)).sort();

/**
 * Container metrics the cluster provides (cAdvisor), which the memory alert and its panel read: the contract's EXTERNAL_METRICS has no
 * memory metric, and the application does not emit one. Named here, with the labels each may carry, so nothing else slips in.
 */
export const CLUSTER_METRICS = Object.freeze({
  container_memory_working_set_bytes: ['pod', 'container', 'namespace'],
  container_spec_memory_limit_bytes: ['pod', 'container', 'namespace'],
});
/** Labels the scrape adds to every series, and the label of the outside probe's two objectives. */
export const TARGET_LABELS = Object.freeze(['instance', 'job']);
export const PROBE_LABELS = Object.freeze(['probe']);
const CATALOGUE_EXTERNAL = Object.freeze(EXTERNAL_METRICS.filter((n) => n !== 'ALERTS'));

const baseOf = (name) => name.replace(/_(bucket|sum|count)$/, '');
const typeOf = (name) => {
  if (METRICS[name]) return METRICS[name].type;
  if (METRICS[baseOf(name)]?.type === 'histogram') return 'histogram';
  return CLUSTER_METRICS[name] ? 'gauge' : 'external';
};

/** The labels a series of this name may carry, or null for a name that is nowhere. */
export function labelsOf(name) {
  if (name in CLUSTER_METRICS) return [...CLUSTER_METRICS[name], ...TARGET_LABELS];
  if (CATALOGUE_EXTERNAL.includes(name)) return [...TARGET_LABELS, ...PROBE_LABELS];
  const def = METRICS[name] ?? (METRICS[baseOf(name)]?.type === 'histogram' ? METRICS[baseOf(name)] : null);
  if (!def || !metricSeriesNames().has(name)) return null;
  return [...def.labels, ...TARGET_LABELS, ...(name.endsWith('_bucket') ? ['le'] : [])];
}

/** Every reason an expression names something that is not in the catalogue, uses a label a metric lacks, or uses a counter or gauge the wrong way. */
export function expressionProblems(expr) {
  const problems = [];
  let ast;
  try {
    ast = parse(String(expr).replace(/\s+/g, ' '));
  } catch (err) {
    return [`does not parse: ${err.message}`];
  }
  const { selectors, groupings } = walk(ast);
  const known = new Set();
  for (const selector of selectors) {
    const allowed = labelsOf(selector.name);
    if (!allowed) {
      problems.push(`${selector.name} is not in the catalogue`);
      continue;
    }
    allowed.forEach((l) => known.add(l));
    for (const { label, value, op } of selector.matchers) {
      if (FORBIDDEN_LABELS.includes(label)) problems.push(`${selector.name} is selected by the forbidden label ${label}`);
      else if (!allowed.includes(label)) problems.push(`${selector.name} has no label ${label}`);
      else if (METRICS[METRICS[selector.name] ? selector.name : baseOf(selector.name)] && !['le', ...TARGET_LABELS].includes(label)) {
        const base = METRICS[selector.name] ? selector.name : baseOf(selector.name);
        const values = op === '=' || op === '!=' ? [value] : value.split('|').filter((v) => /^[\w-]+$/.test(v));
        for (const v of values) {
          const why = metricProblem(base, { [label]: v });
          if (why) problems.push(why);
        }
      }
    }
  }
  for (const label of groupings) {
    if (FORBIDDEN_LABELS.includes(label)) problems.push(`grouped by the forbidden label ${label}`);
    else if (label !== 'le' && !known.has(label)) problems.push(`grouped by ${label}, which none of the metrics has`);
  }
  const countersOnly = ['rate', 'increase'];
  const visit = (node) => {
    if (node.type === 'call') {
      if (countersOnly.includes(node.name) && node.args[0].type === 'selector') {
        const type = typeOf(node.args[0].name);
        if (type === 'gauge') problems.push(`${node.name}() of ${node.args[0].name}, which is a gauge`);
      }
      node.args.forEach(visit);
    }
    if (node.type === 'aggregate') visit(node.arg);
    if (node.type === 'binary') {
      visit(node.left);
      visit(node.right);
    }
  };
  visit(ast);
  return problems;
}

const everyRule = () => files('rules', '.yaml').flatMap((f) => readYaml(`rules/${f}`).groups.flatMap((g) => g.rules.map((r) => ({ ...r, file: f }))));
/** The alert rules. Recording rules (a `record:` name, such as the uptime burn rate) are listed by allRecordings. */
export const allRules = () => everyRule().filter((r) => r.alert);
export const allRecordings = () => everyRule().filter((r) => r.record);
export const allDashboards = () => files('dashboards', '.json').map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(MONITORING, 'dashboards', f), 'utf8')) }));

/** An expression with each recording rule's name replaced by the expression it records, so the metrics and windows it reads can be checked. */
export function expandRecorded(expr) {
  const recorded = new Map(allRecordings().map((r) => [r.record, `(${String(r.expr).replace(/\s+/g, ' ')})`]));
  return String(expr).replace(/\s+/g, ' ').replace(/[A-Za-z_:][A-Za-z0-9_:]*/g, (name) => recorded.get(name) ?? name);
}
