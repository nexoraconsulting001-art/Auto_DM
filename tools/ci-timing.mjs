/**
 * node:test reporter for the CI shards (tools/ci-shard.mjs). It changes nothing about how tests run or what they
 * report; it only prints two kinds of line:
 *   "ci-start <file>"        when the first test of a file starts, so a shard that stalls knows which file it was in
 *   "ci-timing <ms> <file>"  when the file finishes, so tools/gh-results.mjs can collect the times and
 *                            tools/ci-timings.json can balance the next split
 * Each line is written at once: --test-force-exit ends the process before a reporter's last words.
 */
import path from 'node:path';

const relative = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');

export default async function* ciTiming(source) {
  const started = new Set();
  for await (const event of source) {
    const d = event.data ?? {};
    if (!d.file) continue;
    const file = relative(d.file);
    if (event.type === 'test:start' && !started.has(file)) {
      started.add(file);
      yield `ci-start ${file}\n`;
    }
    // Node 22 reports a summary for each file (with its file) and one for the whole run (without).
    if (event.type === 'test:summary' && Number.isFinite(d.duration_ms)) yield `ci-timing ${Math.round(d.duration_ms)} ${file}\n`;
  }
}
