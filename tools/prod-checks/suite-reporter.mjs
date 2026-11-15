/**
 * A node:test reporter that writes one JSON line per finished test, for R-05 to compare two runs of the suite:
 *   {"file":"test/x.test.js","line":12,"column":1,"name":"...","nesting":1,"ok":true,"suite":false,"error":"first line"}
 * Use it as --test-reporter=./tools/prod-checks/suite-reporter.mjs with --test-reporter-destination=<file>.
 * Skipped and todo tests are written with ok true and `skipped: true`, and are not counted by the check.
 */
import path from 'node:path';

const firstLine = (err) => String(err?.cause?.message ?? err?.message ?? '').split('\n').find((l) => l.trim()) ?? '';

export default async function* suiteReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    const row = {
      file: d.file ? path.relative(process.cwd(), d.file).split(path.sep).join('/') : '',
      line: d.line ?? 0,
      column: d.column ?? 0,
      name: d.name,
      nesting: d.nesting ?? 0,
      ok: event.type === 'test:pass',
      suite: d.details?.type === 'suite',
      ...(d.skip !== undefined || d.todo !== undefined ? { skipped: true } : {}),
      ...(event.type === 'test:fail' ? { error: firstLine(d.details?.error).slice(0, 200) } : {}),
    };
    yield `${JSON.stringify(row)}\n`;
  }
}
