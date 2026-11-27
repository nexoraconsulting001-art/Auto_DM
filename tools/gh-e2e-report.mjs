/**
 * Helpers for tools/gh-results.mjs: the Playwright JSON report a failed Browser tests job uploads (see .github/workflows/ci.yml),
 * turned into the report's "Browser test errors (full)" section. Pure functions, so test/tools/gh-e2e-report.test.js can run them.
 * Zip reading uses node:zlib only (the artifact is a plain zip of one JSON file).
 */
import zlib from 'node:zlib';

const ANSI = new RegExp(`${String.fromCharCode(27)}\[[0-9;]*m`, 'g');
export const PER_TEST_CAP = 2000;

/** The files of a zip held in a Buffer, as { name: Buffer }. Reads the central directory; stored and deflated entries only. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad zip directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    if (method === 0) files[name] = Buffer.from(raw);
    else if (method === 8) files[name] = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported zip method ${method}`);
  }
  return files;
}

/** Every failing test in a Playwright JSON report: { file, title, error }. Flaky and passing tests are left out. */
export function failingTests(report) {
  const out = [];
  const walk = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== 'unexpected' && test.status !== 'timedOut') continue;
        const last = (test.results ?? []).at(-1) ?? {};
        const errors = last.errors?.length ? last.errors : last.error ? [last.error] : [];
        const message = errors.map((e) => e.message ?? e.stack ?? '').filter(Boolean).join('\n\n');
        const title = [...(suite.__titles ?? []), spec.title].join(' › ');
        out.push({ file: spec.file ?? here ?? '', title: test.projectName ? `[${test.projectName}] ${title}` : title, error: message });
      }
    }
    for (const child of suite.suites ?? []) walk({ ...child, __titles: [...(suite.__titles ?? []), ...(child.title && child.title !== child.file ? [child.title] : [])] }, here);
  };
  for (const suite of report.suites ?? []) walk({ ...suite, __titles: [] }, suite.file);
  return out;
}

/** Markdown for the failing tests of several reports (each from one shard); '' when nothing failed. */
export function renderE2eErrors(reports) {
  const failures = reports.flatMap((r) => failingTests(r));
  if (!failures.length) return '';
  const md = ['## Browser test errors (full)', ''];
  for (const f of failures) {
    let text = f.error.replace(ANSI, '').replace(/\r\n/g, '\n').trim() || '(no error message in the report)';
    if (text.length > PER_TEST_CAP) text = `${text.slice(0, PER_TEST_CAP - 1)}…`;
    md.push(`### ${f.file ? `\`${f.file}\` ` : ''}${f.title}`, '', '```', text.replace(/```/g, '` ` `'), '```', '');
  }
  return md.join('\n');
}
