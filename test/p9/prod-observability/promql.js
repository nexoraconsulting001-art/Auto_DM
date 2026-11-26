// A small PromQL evaluator and promtool-style rule test runner, so the alert rules are checked here as well as by
// `promtool test rules` in CI (the machine that builds this has no promtool). It reads the same test files promtool reads and
// supports exactly the part of PromQL the rules use; anything else throws, so a rule that outgrows it is noticed.
//
// Supported: selectors with = != =~ !~ matchers, [range] and offset, rate, increase, avg_over_time, max_over_time,
// min_over_time, histogram_quantile, absent, time, abs, sum/avg/min/max/count with `by`, + - * / %, comparisons that
// filter, and, or, unless. rate and increase follow Prometheus's extrapolation.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
export const parseDuration = (text) => {
  const found = [...String(text).matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)];
  if (!found.length || found.map((m) => m[0]).join('') !== String(text)) throw new Error(`Not a duration: ${text}`);
  return found.reduce((sum, m) => sum + Number(m[1]) * DURATION_UNITS[m[2]], 0);
};

// ---- parser ---------------------------------------------------------------------------------------------------------------

function tokenize(source) {
  const tokens = [];
  const patterns = [
    ['space', /^\s+/], ['duration', /^\d+(?:ms|s|m|h|d|w|y)(?![\w])/], ['number', /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i],
    ['string', /^"(?:[^"\\]|\\.)*"/], ['op', /^(?:==|!=|>=|<=|=~|!~|>|<|\+|-|\*|\/|%|=)/], ['punct', /^[(){}[\],]/], ['ident', /^[a-zA-Z_:][a-zA-Z0-9_:]*/],
  ];
  let rest = source;
  while (rest.length) {
    const hit = patterns.map(([type, re]) => [type, re.exec(rest)]).find(([, m]) => m);
    if (!hit) throw new Error(`Unexpected ${JSON.stringify(rest.slice(0, 12))} in the expression`);
    if (hit[0] !== 'space') tokens.push({ type: hit[0], text: hit[1][0] });
    rest = rest.slice(hit[1][0].length);
  }
  return tokens;
}

const AGGREGATIONS = new Set(['sum', 'avg', 'min', 'max', 'count']);
const FUNCTIONS = { rate: 1, increase: 1, avg_over_time: 1, max_over_time: 1, min_over_time: 1, histogram_quantile: 2, absent: 1, time: 0, abs: 1, vector: 1 };
const COMPARISONS = new Set(['==', '!=', '>', '<', '>=', '<=']);

export function parse(source) {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const isText = (text) => peek()?.text === text && peek().type !== 'string';
  const eat = (text) => {
    if (!isText(text)) throw new Error(`Expected ${text} but found ${peek()?.text ?? 'the end'}`);
    return next();
  };

  function binary(operand, ops) {
    let left = operand();
    while (peek() && ops.includes(peek().text) && ['op', 'ident'].includes(peek().type)) {
      const op = next().text;
      left = { type: 'binary', op, left, right: operand() };
    }
    return left;
  }
  const parseOr = () => binary(parseAnd, ['or']);
  const parseAnd = () => binary(parseCompare, ['and', 'unless']);
  const parseCompare = () => binary(parseAdd, [...COMPARISONS]);
  const parseAdd = () => binary(parseMul, ['+', '-']);
  const parseMul = () => binary(parseUnary, ['*', '/', '%']);
  const parseUnary = () => {
    if (isText('-')) {
      next();
      return { type: 'binary', op: '-', left: { type: 'number', value: 0 }, right: parseUnary() };
    }
    return parsePrimary();
  };

  function grouping() {
    if (peek()?.text !== 'by') return null;
    next();
    eat('(');
    const labels = [];
    while (!isText(')')) {
      labels.push(next().text);
      if (isText(',')) next();
    }
    eat(')');
    return labels;
  }

  function parseSelector(name) {
    const matchers = [];
    if (isText('{')) {
      next();
      while (!isText('}')) {
        const label = next().text;
        const op = next().text;
        const raw = next();
        if (raw.type !== 'string') throw new Error(`A matcher value must be a string: ${label}`);
        matchers.push({ label, op, value: JSON.parse(raw.text) });
        if (isText(',')) next();
      }
      eat('}');
    }
    const node = { type: 'selector', name, matchers, range: null, offset: 0 };
    if (isText('[')) {
      next();
      node.range = parseDuration(next().text);
      eat(']');
    }
    if (peek()?.text === 'offset') {
      next();
      node.offset = parseDuration(next().text);
    }
    return node;
  }

  function parsePrimary() {
    const token = next();
    if (!token) throw new Error('The expression ends too soon');
    if (token.type === 'number') return { type: 'number', value: Number(token.text) };
    if (token.text === '(' && token.type === 'punct') {
      const inner = parseOr();
      eat(')');
      return inner;
    }
    if (token.type !== 'ident') throw new Error(`Unexpected ${token.text}`);
    if (AGGREGATIONS.has(token.text) && (isText('(') || peek()?.text === 'by')) {
      let by = grouping();
      eat('(');
      const arg = parseOr();
      eat(')');
      by ??= grouping();
      return { type: 'aggregate', op: token.text, by: by ?? [], arg };
    }
    if (token.text in FUNCTIONS && isText('(')) {
      next();
      const args = [];
      while (!isText(')')) {
        args.push(parseOr());
        if (isText(',')) next();
      }
      eat(')');
      if (args.length !== FUNCTIONS[token.text]) throw new Error(`${token.text} takes ${FUNCTIONS[token.text]} arguments`);
      return { type: 'call', name: token.text, args };
    }
    return parseSelector(token.text);
  }

  const ast = parseOr();
  if (at !== tokens.length) throw new Error(`Unexpected ${peek().text} after the expression`);
  return ast;
}

/** Every selector in an expression, and every label named by a grouping, for the catalogue checks. */
export function walk(ast, found = { selectors: [], groupings: [] }) {
  if (ast.type === 'selector') found.selectors.push(ast);
  if (ast.type === 'aggregate') {
    found.groupings.push(...ast.by);
    walk(ast.arg, found);
  }
  if (ast.type === 'call') ast.args.forEach((a) => walk(a, found));
  if (ast.type === 'binary') {
    walk(ast.left, found);
    walk(ast.right, found);
  }
  return found;
}

// ---- series -----------------------------------------------------------------------------------------------------------------

export function parseSeriesName(text) {
  const found = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?$/.exec(text.trim());
  if (!found) throw new Error(`Not a series: ${text}`);
  const labels = { __name__: found[1] };
  for (const m of (found[2] ?? '').matchAll(/([a-zA-Z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) labels[m[1]] = m[2];
  return labels;
}

/** promtool's value notation: `a+bxn`, `a-bxn`, `axn`, `_`, `_xn`, `stale` and plain numbers. Returns numbers, with null for a missing sample and NaN for stale. */
export function expandValues(text) {
  const out = [];
  const N = '(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
  for (const token of text.trim().split(/\s+/)) {
    let m;
    if (token === '_') out.push(null);
    else if (token === 'stale') out.push(Number.NaN);
    else if ((m = /^_x(\d+)$/.exec(token))) for (let i = 0; i < Number(m[1]); i++) out.push(null);
    else if ((m = new RegExp(`^(-?${N})([+-]${N})x(\\d+)$`, 'i').exec(token))) for (let i = 0; i <= Number(m[3]); i++) out.push(Number(m[1]) + i * Number(m[2]));
    else if ((m = new RegExp(`^(-?${N})x(\\d+)$`, 'i').exec(token))) for (let i = 0; i <= Number(m[2]); i++) out.push(Number(m[1]));
    else if (new RegExp(`^-?${N}$`, 'i').test(token)) out.push(Number(token));
    else throw new Error(`Not a series value: ${token}`);
  }
  return out;
}

export function buildStore(inputSeries, intervalMs) {
  return inputSeries.map(({ series, values }) => {
    const labels = parseSeriesName(series);
    const samples = [];
    expandValues(values).forEach((v, i) => {
      if (v !== null) samples.push({ t: i * intervalMs, v });
    });
    return { labels, samples };
  });
}

// ---- evaluation ---------------------------------------------------------------------------------------------------------------

const LOOKBACK = 300_000;
const keyOf = (labels) => JSON.stringify(Object.entries(labels).filter(([k]) => k !== '__name__').sort());
const without = (labels) => Object.fromEntries(Object.entries(labels).filter(([k]) => k !== '__name__'));

function matches(labels, matchers) {
  return matchers.every(({ label, op, value }) => {
    const have = labels[label] ?? '';
    if (op === '=') return have === value;
    if (op === '!=') return have !== value;
    const re = new RegExp(`^(?:${value})$`);
    return op === '=~' ? re.test(have) : !re.test(have);
  });
}

function between(samples, from, to) {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < from) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < samples.length && samples[i].t <= to; i++) out.push(samples[i]);
  return out;
}

/** Prometheus's extrapolatedRate: the increase over the window, extrapolated to its edges, with counter resets corrected. */
function extrapolated(samples, start, end, { counter, rate }) {
  if (samples.length < 2) return null;
  let delta = samples.at(-1).v - samples[0].v;
  if (counter) for (let i = 1; i < samples.length; i++) if (samples[i].v < samples[i - 1].v) delta += samples[i - 1].v;
  const first = samples[0];
  const last = samples.at(-1);
  const sampled = (last.t - first.t) / 1000;
  const avg = sampled / (samples.length - 1);
  let toStart = (first.t - start) / 1000;
  const toEnd = (end - last.t) / 1000;
  const threshold = avg * 1.1;
  if (counter && delta > 0 && first.v >= 0) toStart = Math.min(toStart, sampled * (first.v / delta));
  let span = sampled;
  span += toStart < threshold ? toStart : avg / 2;
  span += toEnd < threshold ? toEnd : avg / 2;
  const result = delta * (span / sampled);
  return rate ? result / ((end - start) / 1000) : result;
}

function histogramQuantile(q, vector) {
  const groups = new Map();
  for (const { labels, value } of vector) {
    if (labels.le === undefined) continue;
    const rest = { ...labels };
    delete rest.le;
    const key = keyOf(rest);
    groups.set(key, { labels: rest, buckets: [...(groups.get(key)?.buckets ?? []), { le: labels.le === '+Inf' ? Infinity : Number(labels.le), count: value }] });
  }
  const out = [];
  for (const { labels, buckets } of groups.values()) {
    buckets.sort((a, b) => a.le - b.le);
    const total = buckets.at(-1)?.count ?? 0;
    if (buckets.at(-1)?.le !== Infinity) continue;
    if (!(total > 0)) continue;
    const rank = q * total;
    const i = buckets.findIndex((b) => b.count >= rank);
    if (i === buckets.length - 1) {
      out.push({ labels, value: buckets.at(-2)?.le ?? Number.NaN });
      continue;
    }
    const lower = i === 0 ? 0 : buckets[i - 1].le;
    const before = i === 0 ? 0 : buckets[i - 1].count;
    out.push({ labels, value: lower + (buckets[i].le - lower) * ((rank - before) / (buckets[i].count - before)) });
  }
  return out;
}

const ARITHMETIC = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b };
const COMPARE = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b };

export function evaluate(ast, store, now) {
  const instant = (node, when) =>
    store.flatMap(({ labels, samples }) => {
      if (labels.__name__ !== node.name || !matches(labels, node.matchers)) return [];
      const [sample] = between(samples, when - LOOKBACK + 1, when).slice(-1);
      return sample && !Number.isNaN(sample.v) ? [{ labels, value: sample.v }] : [];
    });
  const ranged = (node, when) =>
    store.flatMap(({ labels, samples }) => (labels.__name__ === node.name && matches(labels, node.matchers)
      ? [{ labels, samples: between(samples, when - node.range, when).filter((s) => !Number.isNaN(s.v)), start: when - node.range, end: when }]
      : []));

  function go(node) {
    switch (node.type) {
      case 'number': return node.value;
      case 'selector':
        if (node.range) throw new Error('A range selector needs a function around it');
        return instant(node, now - node.offset);
      case 'aggregate': {
        const vector = go(node.arg);
        const groups = new Map();
        for (const item of vector) {
          const labels = Object.fromEntries(node.by.filter((l) => item.labels[l] !== undefined).map((l) => [l, item.labels[l]]));
          const key = keyOf(labels);
          groups.set(key, { labels, values: [...(groups.get(key)?.values ?? []), item.value] });
        }
        return [...groups.values()].map(({ labels, values }) => ({
          labels,
          value: node.op === 'sum' ? values.reduce((a, b) => a + b, 0) : node.op === 'avg' ? values.reduce((a, b) => a + b, 0) / values.length
            : node.op === 'min' ? Math.min(...values) : node.op === 'max' ? Math.max(...values) : values.length,
        }));
      }
      case 'call': return call(node);
      case 'binary': return binaryOp(node);
      default: throw new Error(`Unsupported ${node.type}`);
    }
  }

  function call({ name, args }) {
    if (name === 'time') return now / 1000;
    if (name === 'vector') return [{ labels: {}, value: go(args[0]) }];
    if (name === 'absent') return go(args[0]).length ? [] : [{ labels: {}, value: 1 }];
    if (name === 'abs') return go(args[0]).map((i) => ({ labels: without(i.labels), value: Math.abs(i.value) }));
    if (name === 'histogram_quantile') return histogramQuantile(go(args[0]), go(args[1]));
    const [selector] = args;
    if (selector.type !== 'selector' || !selector.range) throw new Error(`${name} needs a range selector`);
    const rows = ranged(selector, now - selector.offset);
    const reduce = {
      rate: (s, r) => extrapolated(s, r.start, r.end, { counter: true, rate: true }),
      increase: (s, r) => extrapolated(s, r.start, r.end, { counter: true, rate: false }),
      avg_over_time: (s) => (s.length ? s.reduce((a, b) => a + b.v, 0) / s.length : null),
      max_over_time: (s) => (s.length ? Math.max(...s.map((x) => x.v)) : null),
      min_over_time: (s) => (s.length ? Math.min(...s.map((x) => x.v)) : null),
    }[name];
    return rows.flatMap((r) => {
      const value = reduce(r.samples, r);
      return value === null ? [] : [{ labels: without(r.labels), value }];
    });
  }

  function binaryOp({ op, left, right }) {
    const l = go(left);
    const r = go(right);
    const scalarL = typeof l === 'number';
    const scalarR = typeof r === 'number';
    if (['and', 'or', 'unless'].includes(op)) {
      if (scalarL || scalarR) throw new Error(`${op} needs two vectors`);
      const rightKeys = new Set(r.map((i) => keyOf(i.labels)));
      if (op === 'and') return l.filter((i) => rightKeys.has(keyOf(i.labels)));
      if (op === 'unless') return l.filter((i) => !rightKeys.has(keyOf(i.labels)));
      const leftKeys = new Set(l.map((i) => keyOf(i.labels)));
      return [...l, ...r.filter((i) => !leftKeys.has(keyOf(i.labels)))];
    }
    const apply = (a, b) => (op in ARITHMETIC ? ARITHMETIC[op](a, b) : COMPARE[op](a, b) ? a : null);
    const compare = op in COMPARE;
    if (scalarL && scalarR) return ARITHMETIC[op]?.(l, r) ?? l;
    if (scalarR) return l.flatMap((i) => (compare ? (COMPARE[op](i.value, r) ? [{ labels: without(i.labels), value: i.value }] : []) : [{ labels: without(i.labels), value: apply(i.value, r) }]));
    if (scalarL) return r.flatMap((i) => (compare ? (COMPARE[op](l, i.value) ? [{ labels: without(i.labels), value: i.value }] : []) : [{ labels: without(i.labels), value: apply(l, i.value) }]));
    const byKey = new Map(r.map((i) => [keyOf(i.labels), i]));
    return l.flatMap((i) => {
      const other = byKey.get(keyOf(i.labels));
      if (!other) return [];
      if (compare) return COMPARE[op](i.value, other.value) ? [{ labels: without(i.labels), value: i.value }] : [];
      return [{ labels: without(i.labels), value: apply(i.value, other.value) }];
    });
  }

  const result = go(ast);
  return typeof result === 'number' ? [{ labels: {}, value: result }] : result.map((i) => ({ labels: without(i.labels), value: i.value }));
}

// ---- rule tests ---------------------------------------------------------------------------------------------------------------

export function loadRules(file) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  // A recording rule's value is its expression at the same instant, so an alert that reads the recorded name is the alert over that
  // expression (Prometheus evaluates a group's rules in order at one timestamp).
  const flat = (expr) => String(expr).replace(/\s+/g, ' ');
  const recorded = new Map(doc.groups.flatMap((g) => g.rules.filter((r) => r.record).map((r) => [r.record, flat(r.expr)])));
  const expand = (expr) => flat(expr).replace(/[A-Za-z_:][A-Za-z0-9_:]*/g, (name) => (recorded.has(name) ? `(${recorded.get(name)})` : name));
  return doc.groups.flatMap((g) => g.rules.filter((r) => r.alert).map((rule) => ({ ...rule, group: g.name, ast: parse(expand(rule.expr)) })));
}

/** The alerts firing at `evalTimes` (ms), from simulating every evaluation from time 0, as Prometheus does. */
export function simulate(rule, store, evalTimes, stepMs) {
  const last = Math.max(...evalTimes);
  const want = new Set(evalTimes);
  const active = new Map();
  const snapshots = new Map();
  const forMs = rule.for ? parseDuration(rule.for) : 0;
  for (let t = 0; t <= last; t += stepMs) {
    const results = evaluate(rule.ast, store, t);
    const seen = new Set();
    for (const { labels } of results) {
      const key = keyOf(labels);
      seen.add(key);
      if (!active.has(key)) active.set(key, { since: t, labels });
    }
    for (const key of [...active.keys()]) if (!seen.has(key)) active.delete(key);
    if (want.has(t)) {
      snapshots.set(t, [...active.values()].filter((a) => t - a.since >= forMs).map((a) => ({ ...a.labels, ...(rule.labels ?? {}), alertname: rule.alert, annotations: rule.annotations ?? {} })));
    }
  }
  return snapshots;
}

const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Runs one promtool test file and returns one row per check: { test, alert, time, ok, why }. */
export function runRuleTests(testFile) {
  const doc = yaml.load(fs.readFileSync(testFile, 'utf8'));
  const dir = path.dirname(testFile);
  const rules = doc.rule_files.flatMap((f) => loadRules(path.resolve(dir, f)));
  const evalStep = parseDuration(doc.evaluation_interval ?? '1m');
  const rows = [];
  for (const test of doc.tests) {
    const interval = parseDuration(test.interval ?? '1m');
    const store = buildStore(test.input_series ?? [], interval);
    const byAlert = new Map();
    for (const check of test.alert_rule_test ?? []) byAlert.set(check.alertname, [...(byAlert.get(check.alertname) ?? []), check]);
    for (const [alertname, checks] of byAlert) {
      const rule = rules.find((r) => r.alert === alertname);
      if (!rule) {
        rows.push({ test: test.name, alert: alertname, time: null, ok: false, why: 'no such rule' });
        continue;
      }
      const times = checks.map((c) => parseDuration(c.eval_time));
      const snapshots = simulate(rule, store, times, evalStep);
      for (const check of checks) {
        const time = parseDuration(check.eval_time);
        const got = snapshots.get(time).map(({ annotations, ...labels }) => ({ labels, annotations }));
        const expected = (check.exp_alerts ?? []).map((a) => ({ labels: a.exp_labels ?? {}, annotations: a.exp_annotations ?? {} }));
        const ok = got.length === expected.length && expected.every((e) => got.some((g) => same(g.labels, e.labels) && same(g.annotations, e.annotations)));
        rows.push({ test: test.name, alert: alertname, time: check.eval_time, ok, expectedCount: expected.length, gotCount: got.length, got: JSON.stringify(got.map((g) => g.labels)), why: ok ? '' : `expected ${expected.length} alerts, got ${got.length}: ${JSON.stringify(got.map((g) => g.labels))}` });
      }
    }
  }
  return rows;
}
