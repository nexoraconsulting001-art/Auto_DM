/**
 * node:test reporter for the CI shards (tools/ci-shard.mjs): prints how long each test file took, as a
 * "ci-timing <ms> <file>" line when the file finishes, so tools/gh-results.mjs can collect them and
 * tools/ci-timings.json can balance the next split. It changes nothing about how tests run or what they report.
 * Each line is written as its file finishes: --test-force-exit ends the process before a reporter's last words.
 */
import path from 'node:path';

const relative = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');

export default async function* ciTiming(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    // Node 22 reports a summary for each file (with its file) and one for the whole run (without).
    if (event.type === 'test:summary' && d.file && Number.isFinite(d.duration_ms)) yield `ci-timing ${Math.round(d.duration_ms)} ${relative(d.file)}\n`;
  }
}
