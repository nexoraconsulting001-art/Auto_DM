// `npm run golive`: the go-live checklist (Phase 10; G-15, G-16). One line per item of GOLIVE_ITEMS
// (src/contracts/golive.js): ready or missing, who must act, and whether it blocks go-live.
//
//   npm run golive                     the whole list, as text
//   npm run golive -- --json           GoliveStatus as JSON
//   npm run golive -- --blocking       only the items that block go-live
//   npm run golive -- --owner user     only what the founder must do (or: us)
//   npm run golive -- --offline        settings and sign-offs only: no outside service is asked, and every probe is `unknown`
//
// Exit code: 0 when no blocking item is open, 1 while one is, 2 for a bad argument or a part that is not built.
// It reads the configuration the server would run with (secrets from their source included) and never prints the value
// of any setting: an item's detail is a fixed phrase or a setting's name.
//
// parseArgs is built. run() is the golive track's: it builds the status through src/modules/golive (createGolive) on the
// runtime database and adapters, prints it with formatStatus, and answers goliveExitCode.
import { pathToFileURL } from 'node:url';
import { GOLIVE_OWNERS, GOLIVE_STATES, goliveExitCode } from '../src/contracts/golive.js';

export class GoliveArgError extends Error {}

export function parseArgs(argv) {
  const options = { json: false, blocking: false, owner: null, offline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--blocking') options.blocking = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--owner') {
      options.owner = argv[i += 1];
      if (!GOLIVE_OWNERS.includes(options.owner)) throw new GoliveArgError(`--owner takes ${GOLIVE_OWNERS.join(' or ')}`);
    } else throw new GoliveArgError(`Unknown argument: ${arg}`);
  }
  return options;
}

const MARK = Object.freeze({ ready: 'ready  ', missing: 'MISSING', unknown: 'UNKNOWN' });

/** The list as text: one line per item, blocking ones first, and a last line with the verdict. No value of any setting. */
export function formatStatus(status, { blocking = false, owner = null } = {}) {
  const shown = status.items
    .filter((i) => (!blocking || i.blocks) && (!owner || i.owner === owner))
    .sort((a, b) => Number(b.blocks) - Number(a.blocks) || GOLIVE_STATES.indexOf(b.state) - GOLIVE_STATES.indexOf(a.state));
  const lines = shown.map((i) => `${MARK[i.state]}  ${i.blocks ? 'blocks ' : '       '} ${i.owner.padEnd(4)} ${i.id.padEnd(28)} ${i.title}${i.state === 'ready' ? '' : `  (${i.detail})`}`);
  const open = status.items.filter((i) => i.blocks && i.state !== 'ready').length;
  lines.push('', open ? `Not ready for go-live: ${open} blocking item${open === 1 ? '' : 's'} open.` : 'Ready for go-live: no blocking item is open.');
  return lines.join('\n');
}

export async function run(_options) {
  throw Object.assign(new Error('The go-live checklist is not built yet (the golive track builds it).'), { code: 'not_implemented' });
}

export { goliveExitCode };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const status = await run(options);
    process.stdout.write(`${options.json ? JSON.stringify(status, null, 2) : formatStatus(status, options)}\n`);
    process.exit(goliveExitCode(status));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}
