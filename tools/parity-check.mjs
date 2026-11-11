/**
 * `npm run parity`: everything a seller can do on the web, they can do in the owner app (PRD 10.4).
 *
 * Every /api/v1 route an owner can reach, and every page a console feature registers, must be listed in the
 * `routeIds` of some feature in apps/owner/src/features (a page as 'console:/orders/:id'). The only exemption is a
 * route flagged `consoleOnly` in the contract: an ops function. There is no web-only flag, and the contract refuses one.
 * The check names each thing that is missing and exits 1.
 *
 * While the app is being built, tools/parity-pending.json lists what is not mapped yet. A track that builds a
 * screen adds the ids to its feature and deletes them from that file; an entry that is mapped, or that names
 * nothing, fails the check too, so the file can only shrink. The release track turns it off for good:
 *
 *   node tools/parity-check.mjs            the allowance file counts
 *   node tools/parity-check.mjs --strict   it does not: anything unmapped fails
 *   node tools/parity-check.mjs --prune    rewrites the file without the entries that are now mapped or gone
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { readAppFeatures, readConsolePages } = createRequire(import.meta.url)('./parity-read.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PENDING_PATH = 'tools/parity-pending.json';
const OWNER = Object.freeze({ id: 0, role: 'owner', permissions: [] });

/** The same rule the server's guard uses (src/contracts/api/access.js), without importing the contract into this function. */
const ownerCanReach = (access) => Boolean(access?.public || access?.signedIn || access?.roles?.includes(OWNER.role));

/**
 * The verdict, from plain data:
 *   routes     [{ id, access, consoleOnly? }]   the contract's route list
 *   pages      [{ id, feature }]               console pages, id 'console:/path'
 *   features   [{ name, routeIds }]            what each app feature says it covers
 *   pending    { routes: [], pages: [] }       the allowance; ignored when strict
 * Answers { ok, missing, unknown, stale, problems, counts }: `problems` is every sentence to print.
 */
export function checkParity({ routes, pages, features, pending = { routes: [], pages: [] }, strict = false }) {
  const problems = [];
  const required = new Map(); // id -> what it is, for the message
  for (const route of routes) {
    for (const field of Object.keys(route)) {
      if (/^web[-_]?only$/i.test(field)) problems.push(`Route "${route.id}" is flagged ${field}: there is no web-only flag. A route the app cannot reach is a bug in the app`);
    }
    if (route.consoleOnly || !ownerCanReach(route.access)) continue;
    required.set(route.id, `route ${route.id}`);
  }
  for (const page of pages) required.set(page.id, `console page ${page.id.slice('console:'.length)} (console/src/features/${page.feature})`);

  const covered = new Map(); // id -> feature names
  for (const feature of features) {
    for (const id of feature.routeIds) covered.set(id, [...(covered.get(id) ?? []), feature.name]);
  }
  const known = new Set([...required.keys(), ...routes.map((route) => route.id)]);
  const unknown = [];
  for (const [id, names] of covered) {
    if (!known.has(id)) unknown.push({ id, features: names });
  }
  const allowed = new Set(strict ? [] : [...(pending.routes ?? []), ...(pending.pages ?? [])]);
  const missing = [...required.keys()].filter((id) => !covered.has(id) && !allowed.has(id));
  const stale = strict ? [] : [...allowed].filter((id) => covered.has(id) || !required.has(id));

  for (const id of missing) problems.push(`No app screen for ${required.get(id)}: add "${id}" to the routeIds of a feature in apps/owner/src/features`);
  for (const { id, features: names } of unknown) problems.push(`apps/owner/src/features/${names[0]} lists "${id}", which is not a route id or a console page`);
  for (const id of stale) problems.push(`${PENDING_PATH} still lists "${id}", which is ${covered.has(id) ? 'mapped now' : 'not a route or page any more'}: delete it`);
  return {
    ok: problems.length === 0,
    missing,
    unknown: unknown.map((u) => u.id),
    stale,
    problems,
    counts: { required: required.size, mapped: [...required.keys()].filter((id) => covered.has(id)).length, pending: [...required.keys()].filter((id) => !covered.has(id) && allowed.has(id)).length },
  };
}

export function readPending(root = ROOT) {
  const file = path.join(root, PENDING_PATH);
  if (!fs.existsSync(file)) return { routes: [], pages: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...data, routes: data.routes ?? [], pages: data.pages ?? [] };
}

/** Everything the check needs, read from the repository. */
export async function gather(root = ROOT) {
  const contract = await import(pathToFileURL(path.join(root, 'src/contracts/api/index.js')).href);
  const app = readAppFeatures(root);
  const consolePages = readConsolePages(root);
  return {
    routes: contract.routeList.map((route) => ({ ...route })),
    pages: consolePages.pages,
    features: app.features,
    pending: readPending(root),
    readProblems: [...app.problems, ...consolePages.problems],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const strict = process.argv.includes('--strict');
  const input = await gather();
  if (process.argv.includes('--prune')) {
    const { stale } = checkParity(input);
    const keep = (list) => list.filter((id) => !stale.includes(id)).sort();
    const next = { ...input.pending, routes: keep(input.pending.routes), pages: keep(input.pending.pages) };
    fs.writeFileSync(path.join(ROOT, PENDING_PATH), `${JSON.stringify(next, null, 2)}\n`);
    console.log(`parity: removed ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} from ${PENDING_PATH}`);
  }
  const result = checkParity({ ...input, pending: readPending(), strict });
  const problems = [...input.readProblems, ...result.problems];
  for (const problem of problems) console.error(problem);
  const { required, mapped, pending } = result.counts;
  if (problems.length) {
    console.error(`\nparity: ${problems.length} problem(s). Every seller route and console page needs an app screen (PRD 10.4).`);
    process.exit(1);
  }
  console.log(`parity: ${required} routes and pages; ${mapped} mapped to app screens${strict ? '' : `, ${pending} still listed in ${PENDING_PATH}`}.`);
}
