// Shared by the screencast rehearsals: reads a script from the App Review pack, so a rehearsal can never walk a script the pack does not hold.
// Each rehearsal runs its steps with test.step(<the step's tap text>), so the saved video and the report follow the script step for step.
import fs from 'node:fs';

const PACK = new URL('../../../docs/go-live/meta-app-review/pack.json', import.meta.url);

export function scriptOf(id) {
  const pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
  const script = pack.screencasts.find((s) => s.id === id);
  if (!script) throw new Error(`The review pack has no screencast ${id}`);
  return script;
}

/** Playwright's own recorder: a video of each rehearsal, in test-results (never committed). 360x740 is the console's smallest phone. */
export const VIDEO = { mode: 'on', size: { width: 360, height: 740 } };
export const PHONE = { width: 360, height: 740 };
