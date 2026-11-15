/**
 * The report of a readiness check: the steps the list promises, each with ok and a detail that says exactly what differed
 * (counts, names and ids; never an address, a key or a business's data).
 *
 *   const report = createReport('r06', { steps: READINESS_CHECKS.r06.steps, scrub });
 *   await report.step('two_servers_ready', async () => 'both answer');            // a string is an ok detail
 *   await report.step('x', async () => ({ problems: ['what differed'] }));         // a problem list fails the step
 *   await report.step('y', fn, { blocking: true });                                // a failure stops the steps after it
 *   report.finish() -> { check, ok, steps, startedAt, finishedAt, reduced? }
 */
const MAX_DETAIL = 1800;

export function describeProblems(problems, { limit = 12 } = {}) {
  const list = problems.filter(Boolean);
  if (list.length <= limit) return list.join('; ');
  return `${list.slice(0, limit).join('; ')}; and ${list.length - limit} more`;
}

export function createReport(check, { steps = [], scrub = (t) => t, reduced = false } = {}) {
  const startedAt = new Date().toISOString();
  const done = new Map();
  let blockedBy = null;

  const record = (name, ok, detail, extra = {}) => {
    const text = scrub(String(detail ?? '')).slice(0, MAX_DETAIL);
    done.set(name, { name, ok, ...(text ? { detail: text } : {}), ...extra });
    return ok;
  };

  async function step(name, fn, { blocking = false } = {}) {
    if (blockedBy) return record(name, false, `not run: ${blockedBy} failed`);
    let ok = true;
    let detail = '';
    let extra = {};
    try {
      const result = await fn();
      if (result && typeof result === 'object') {
        ok = result.ok !== false && !(result.problems?.length);
        detail = result.problems?.length ? describeProblems(result.problems) : (result.detail ?? '');
        if (result.skipped) extra = { skipped: true };
      } else {
        detail = result ?? '';
      }
    } catch (err) {
      ok = false;
      detail = err?.message ? String(err.message).split('\n')[0] : 'failed';
    }
    record(name, ok, detail, extra);
    if (!ok && blocking) blockedBy = name;
    return ok;
  }

  return {
    step,
    /** A step that cannot be judged here, reported as not passed with the reason. */
    fail: (name, detail) => record(name, false, detail),
    has: (name) => done.has(name),
    get blocked() {
      return blockedBy;
    },
    finish() {
      const names = steps.length ? [...steps] : [...done.keys()];
      const out = names.map((name) => done.get(name) ?? { name, ok: false, detail: blockedBy ? `not run: ${blockedBy} failed` : 'not run' });
      for (const [name, s] of done) if (!names.includes(name)) out.push(s);
      return { check, ok: out.every((s) => s.ok), steps: out, startedAt, finishedAt: new Date().toISOString(), ...(reduced ? { reduced: true } : {}) };
    },
  };
}
