/**
 * node:test reporter for tools/gate.mjs: one JSON line per finished test.
 * Passing, skipped and failing tests all arrive here; the gate does the counting.
 */
import { stderrNotes } from './ci-annotate.mjs';

export default async function* gateReporter(source) {
  const notes = stderrNotes();
  for await (const event of source) {
    if (event.type === 'test:stderr') notes.add(event.data.file, event.data.message);
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    const error = d.details?.error;
    yield `${JSON.stringify({
      failed: event.type === 'test:fail',
      name: d.name,
      file: d.file,
      line: d.line,
      nesting: d.nesting,
      type: d.details?.type ?? 'test',
      skip: d.skip !== undefined,
      todo: d.todo !== undefined,
      failureType: error?.failureType,
      message: error ? notes.explain(d.file, String(error.cause?.message ?? error.message ?? '')).slice(0, 600) : undefined,
    })}\n`;
  }
}
