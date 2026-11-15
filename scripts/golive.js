// `npm run golive`: the go-live checklist (Phase 10; G-15, G-16). One line per item of GOLIVE_ITEMS
// (src/contracts/golive.js): ready, missing or not checked, who must act, the phase it blocks, whether it blocks
// go-live, and the next step for each one that is not ready.
//
//   npm run golive                     the whole list, as text, with the live probes
//   npm run golive -- --json           GoliveStatus as JSON
//   npm run golive -- --markdown       the report as Markdown (for a ticket or a hand-over)
//   npm run golive -- --blocking       only the items that block go-live
//   npm run golive -- --owner user     only what the founder must do (or: us)
//   npm run golive -- --offline        settings and sign-offs only: no outside service is asked, and every probe that
//                                      would ask one is "not checked"
//
// Exit code: 0 when no blocking item is open, 1 while one is, 2 for a bad argument or when the checklist cannot run.
// It reads the configuration the server would run with (secrets from their source included) and never prints the value
// of any setting: an item's detail is a fixed phrase or a setting's name. The work is in tools/golive.
import { pathToFileURL } from 'node:url';
import { GOLIVE_OWNERS, goliveExitCode } from '../src/contracts/golive.js';
import { formatMarkdown, formatText, run as runChecklist } from '../tools/golive/index.mjs';

export class GoliveArgError extends Error {}

export function parseArgs(argv) {
  // `markdown` is there only when asked for, so the options of the older flags read as they always have.
  const options = { json: false, blocking: false, owner: null, offline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--markdown') options.markdown = true;
    else if (arg === '--blocking') options.blocking = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--owner') {
      options.owner = argv[i += 1];
      if (!GOLIVE_OWNERS.includes(options.owner)) throw new GoliveArgError(`--owner takes ${GOLIVE_OWNERS.join(' or ')}`);
    } else throw new GoliveArgError(`Unknown argument: ${String(arg).slice(0, 40)}`);
  }
  if (options.json && options.markdown) throw new GoliveArgError('Choose --json or --markdown, not both');
  return options;
}

/** The list as text: grouped by who must act and the phase it blocks, the next step under each open item, the verdict last. */
export function formatStatus(status, { blocking = false, owner = null } = {}) {
  return formatText(status, { blocking, owner });
}

export async function run(options) {
  return runChecklist(options);
}

export { goliveExitCode };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  try {
    const status = await run(options);
    const out = options.json ? JSON.stringify(status, null, 2) : options.markdown ? formatMarkdown(status, options) : formatStatus(status, options);
    process.stdout.write(`${out}\n`, () => process.exit(goliveExitCode(status)));
  } catch (err) {
    // Only a message this tool wrote: an error from deeper down can carry an address or a value.
    process.stderr.write(`${err?.name === 'GoliveRunError' ? err.message : 'The go-live checklist could not run.'}\n`);
    process.exit(2);
  }
}
