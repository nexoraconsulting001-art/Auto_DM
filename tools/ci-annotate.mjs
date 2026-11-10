/**
 * node:test reporter for CI: prints the first failures as GitHub ::error:: annotations, so a failed run
 * can be read through the public API (tools/ci-wait.mjs) without logging in. GitHub keeps 10 per step.
 */
import path from 'node:path';

const MAX_ANNOTATIONS = 10;
const MAX_MESSAGE = 700;

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (s) => String(s).replace(ANSI, '').trim();
const relative = (file) => (file ? path.relative(process.cwd(), file).split(path.sep).join('/') : '');

/**
 * What each test file printed to stderr. A file that crashes before any test runs fails with only
 * "test failed", so this is where the reason is. Node reports these paths relative, failures absolute.
 */
export function stderrNotes() {
  const byFile = new Map();
  const key = (file) => path.resolve(String(file ?? ''));
  return {
    add: (file, text) => byFile.set(key(file), `${byFile.get(key(file)) ?? ''}${text}`.slice(-8000)),
    /** The message to show: the test's own, or the file's error output when it has none worth showing. */
    explain(file, message) {
      if (message && message !== 'test failed') return message;
      const text = byFile.get(key(file)) ?? '';
      const at = text.search(/^.*Error\b/m);
      return (at >= 0 ? text.slice(at) : text).trim() || message || 'test failed';
    },
  };
}

/** One ::error:: line for a failed test. */
export function annotation({ file, line, name, message }) {
  return `::error file=${escapeProperty(relative(file))},line=${Number(line) || 1},title=${escapeProperty(plain(name))}::${escapeData(plain(message).slice(0, MAX_MESSAGE))}\n`;
}

export default async function* ciAnnotate(source) {
  let shown = 0;
  let hidden = 0;
  const notes = stderrNotes();
  for await (const event of source) {
    if (event.type === 'test:stderr') notes.add(event.data.file, event.data.message);
    if (event.type !== 'test:fail') continue;
    const d = event.data;
    const error = d.details?.error;
    if (error?.failureType === 'subtestsFailed') continue; // its failing subtests are reported themselves
    if (shown >= MAX_ANNOTATIONS) {
      hidden++;
      continue;
    }
    shown++;
    yield annotation({ file: d.file, line: d.line, name: d.name, message: notes.explain(d.file, error?.cause?.message ?? error?.message) });
  }
  if (hidden) yield `::error title=More failures::${hidden} more failing test(s) are not shown here; see the job log.\n`;
}
