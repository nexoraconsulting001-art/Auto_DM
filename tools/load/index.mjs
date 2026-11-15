/**
 * `npm run load`: the load test (Phase 8, Q-05 to Q-07). Ten businesses on a Postgres set as the QA server's, the web app
 * and the worker as separate processes under their memory limits, traffic from autocannon in the stated mix, every outside
 * service a simulator from tools/sim. Nothing leaves this machine, and it refuses to run with NODE_ENV=production.
 *
 *   npm run load                      all three parts: the mix (Q-05), the comment storm (Q-06), the restart (Q-07)
 *   npm run load -- --part mix        one part: mix, storm or restart
 *   npm run load -- --seconds 30      a shorter run than budgets.json says (the report says so, and it is not a pass of record)
 *   npm run load -- --out <name>      the report's folder under test-results (default: load)
 *
 * Every limit is data in budgets.json; this file holds none. The pieces: stack.mjs (Postgres with the QA settings and two
 * logins, the two processes, the report writer), world.mjs (the ten businesses and the simulators), traffic.mjs and http.mjs
 * (the mix, an open-loop driver), monitor.mjs (memory, queues, database answer), verify.mjs (lost and twice), analyze.mjs
 * (the judgement) and runner.mjs (the three parts and the report). The exit code is 0 for a pass, 1 for a failed check or a
 * run that did not finish, 2 for a mistake in how it was started. docs/runbooks/load-test.md says how to read the report.
 *
 *
 *   run(options) -> report
 *
 *   options   { parts: ['mix', 'storm', 'restart'], seconds: number|null, out: 'load', budgets }
 *   report    what writeReport takes, with one check per limit:
 *               Q-05  failed requests (limit 0), p95 per route class against budgets.p95Ms, and the highest resident
 *                     memory of web, worker and Postgres against budgets.memoryMb
 *               Q-06  with budgets.storm.comments comments on one business inside budgets.storm.overSeconds: another
 *                     business's send delay p95 and page p95 against budgets.storm.otherBusiness
 *               Q-07  web and worker killed hard budgets.restart.afterSeconds into the mix and started again: every
 *                     webhook that was answered 200 is stored and handled once (lost 0), and no send has a twin
 *                     (duplicates 0), counted from the Meta simulator's own record of what it received
 *
 * The ten businesses are made through the same seed loader as the showcase (scripts/showcase.js) from generated seed
 * files, never by inserting rows, and are named by number: nothing here names a business.
 *
 * Route classes (budgets.mix[].class), each a list of real routes the track picks from the contracts:
 *   buyer_page        a business's landing and store pages on its own host
 *   beacon            the traffic beacon those pages call
 *   webhook           signed Meta webhooks (comments, DMs, story replies) through tools/sim/meta
 *   store_api         cart and checkout routes
 *   seller_api_read   /api/v1 reads with a seller's session
 *   seller_api_write  /api/v1 writes with a seller's session
 */
import { pathToFileURL } from 'node:url';
import { loadBudgets } from './stack.mjs';
import { runLoad } from './runner.mjs';

export { loadBudgets, nodeFlags, postgresFlags, rssMb, startNode, startPostgres, writeReport } from './stack.mjs';

export const PARTS = Object.freeze(['mix', 'storm', 'restart']);
export const PART_REQUIREMENTS = Object.freeze({ mix: 'Q-05', storm: 'Q-06', restart: 'Q-07' });

export class LoadError extends Error {}

export function parseArgs(argv) {
  const options = { parts: [], seconds: null, out: 'load' };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new LoadError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--part') options.parts.push(value(i++, arg));
    else if (arg === '--seconds') options.seconds = Number(value(i++, arg));
    else if (arg === '--out') options.out = value(i++, arg);
    else throw new LoadError(`Unknown option ${arg}`);
  }
  for (const part of options.parts) if (!PARTS.includes(part)) throw new LoadError(`--part is one of ${PARTS.join(', ')}`);
  if (!options.parts.length) options.parts = [...PARTS];
  if (options.seconds !== null && (!Number.isInteger(options.seconds) || options.seconds < 5 || options.seconds > 540)) throw new LoadError('--seconds is a whole number from 5 to 540');
  return options;
}

/** Runs the parts and answers the report (see runner.mjs). `budgets` is required: the tool never guesses its limits. */
export async function run(options) {
  if (!options?.budgets) throw new LoadError('run() needs options.budgets (tools/load/budgets.json read by loadBudgets): it is not built to guess its limits.');
  const parts = options.parts?.length ? options.parts : [...PARTS];
  for (const part of parts) if (!PARTS.includes(part)) throw new LoadError(`--part is one of ${PARTS.join(', ')}`);
  if (options.seconds != null && (!Number.isInteger(options.seconds) || options.seconds < 5 || options.seconds > 540)) throw new LoadError('--seconds is a whole number from 5 to 540');
  return runLoad({ budgets: options.budgets, parts, seconds: options.seconds ?? null, out: options.out ?? 'load', say: options.say, root: options.root });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    if (String(process.env.NODE_ENV).toLowerCase() === 'production') throw new LoadError('The load test never runs with NODE_ENV=production');
    const options = parseArgs(process.argv.slice(2));
    const report = await run({ ...options, budgets: loadBudgets() });
    // embedded-postgres' exit hook has nothing left to stop by now and would only print a warning about process.exit.
    process.removeAllListeners('exit');
    process.exit(report.ok ? 0 : 1);
  })().catch((err) => {
    console.error(`load: ${err.message}`);
    process.exit(err instanceof LoadError ? 2 : 1);
  });
}
