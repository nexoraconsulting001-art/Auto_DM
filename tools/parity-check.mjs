/**
 * `npm run parity`: everything a seller can do on the web, they can do in the owner app (PRD 10.4: P-14, P-15, P-16).
 *
 * Every /api/v1 route an owner can reach, and every page a console feature registers, must be listed in the
 * `routeIds` of some feature in apps/owner/src/features (a page as 'console:/orders/:id'). Anything that is not is
 * named, and the check exits 1. Exempt are only:
 *
 *   consoleOnly                a route flagged `consoleOnly: true` in the contract (CONSOLE_ONLY_ROUTES): an ops
 *                              function that lives in the Platform Console. Exactly `true`; any other value is refused
 *   NOT_SERVED_IN_PRODUCTION   a route no production server answers at all (below), so no owner can reach it. No
 *                              feature may list one either: a screen must never call it
 *
 * There is no web-only flag. A route, a console page or an app feature that carries one (webOnly, web_only,
 * desktopOnly, noApp, skipParity, ...) is refused by name, and the contract refuses any field it does not know when it
 * loads (assertRouteFields), so the check names that too.
 *
 * The check is strict: the owner app is released with every route and page mapped. tools/parity-pending.json, the
 * allowance used while the app was being built, must stay empty: an entry in it is itself a failure. A track that adds
 * a seller route or a console page adds its app screen in the same change.
 *
 *   node tools/parity-check.mjs                 the check (`--strict` is accepted and changes nothing)
 *   node tools/parity-check.mjs --root <dir>    the same check on another checkout of the repository
 *
 * checkParity() keeps its `strict` option for callers that pass their own allowance (tests of the rule itself); the
 * command line always runs it strict.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { readAppFeatures, readConsolePages } = createRequire(import.meta.url)('./parity-read.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PENDING_PATH = 'tools/parity-pending.json';
const OWNER = Object.freeze({ id: 0, role: 'owner', permissions: [] });

/**
 * Routes no production server answers, each with the reason. Adding one needs the same proof auth.login has in
 * test/p5/app-release: the route answers 404 with the setting off, and a production server refuses to start with it on.
 */
export const NOT_SERVED_IN_PRODUCTION = Object.freeze({
  'auth.login': 'the Phase 0 phone-and-password sign-in, answered only while PASSWORD_LOGIN is on (tests and local runs); no production server starts with it on, and sellers have no passwords',
});

/** A field that would let a route or page go without an app screen. consoleOnly, spelled exactly so, is the one exemption. */
const WEB_ONLY_FIELD = /^(?:web|desktop|browser|laptop|admin|site)[\s_-]*only$|^no[\s_-]*(?:app|mobile|parity)$|^(?:skip|exempt|ignore|without)[\s_-]*(?:app|parity)$|^parity[\s_-]*(?:skip|exempt|ignore|off)$|^(?:app|mobile)[\s_-]*(?:exempt|hidden|skip|optional)$/i;
const CONSOLE_ONLY_LOOKALIKE = /^console[\s_-]*only$/i;
export const isWebOnlyField = (field) => WEB_ONLY_FIELD.test(String(field));

/** The same rule the server's guard uses (src/contracts/api/access.js), without importing the contract into this function. */
const ownerCanReach = (access) => Boolean(access?.public || access?.signedIn || access?.roles?.includes(OWNER.role));

/**
 * The verdict, from plain data:
 *   routes     [{ id, access, consoleOnly? }]   the contract's route list
 *   pages      [{ id, feature }]               console pages, id 'console:/path'
 *   features   [{ name, routeIds }]            what each app feature says it covers
 *   pending    { routes: [], pages: [] }       the allowance; when strict it must be empty
 * Answers { ok, missing, unknown, stale, exempt, problems, counts }: `problems` is every sentence to print.
 */
export function checkParity({ routes, pages, features, pending = { routes: [], pages: [] }, strict = false }) {
  const problems = [];
  const required = new Map(); // id -> what it is, for the message
  const exempt = { consoleOnly: [], notServed: [] };
  for (const route of routes) {
    for (const field of Object.keys(route)) {
      if (isWebOnlyField(field)) problems.push(`Route "${route.id}" is flagged ${field}: there is no web-only flag. A route the app cannot reach is a bug in the app`);
      else if (CONSOLE_ONLY_LOOKALIKE.test(field) && field !== 'consoleOnly') problems.push(`Route "${route.id}" is flagged ${field}: the one exemption is spelled consoleOnly, for an ops function in the Platform Console`);
    }
    if ('consoleOnly' in route && route.consoleOnly !== true) problems.push(`Route "${route.id}": consoleOnly is true or absent, not ${JSON.stringify(route.consoleOnly)}`);
    if (route.consoleOnly === true) {
      exempt.consoleOnly.push(route.id);
      continue;
    }
    if (Object.hasOwn(NOT_SERVED_IN_PRODUCTION, route.id)) {
      exempt.notServed.push(route.id);
      continue;
    }
    if (!ownerCanReach(route.access)) continue;
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
  const listed = [...(pending.routes ?? []), ...(pending.pages ?? [])];
  const allowed = new Set(strict ? [] : listed);
  const missing = [...required.keys()].filter((id) => !covered.has(id) && !allowed.has(id));
  const stale = strict ? [] : [...allowed].filter((id) => covered.has(id) || !required.has(id));

  for (const id of missing) problems.push(`No app screen for ${required.get(id)}: add "${id}" to the routeIds of a feature in apps/owner/src/features`);
  for (const { id, features: names } of unknown) problems.push(`apps/owner/src/features/${names[0]} lists "${id}", which is not a route id or a console page`);
  for (const id of exempt.notServed.filter((notServed) => covered.has(notServed))) {
    problems.push(`apps/owner/src/features/${covered.get(id)[0]} lists "${id}", which no production server answers (${NOT_SERVED_IN_PRODUCTION[id].split(',')[0]}): no app screen may call it`);
  }
  for (const id of stale) problems.push(`${PENDING_PATH} still lists "${id}", which is ${covered.has(id) ? 'mapped now' : 'not a route or page any more'}: delete it`);
  if (strict) {
    for (const id of listed) problems.push(`${PENDING_PATH} lists "${id}": the file must be empty, because the app is released with every seller route and console page mapped. Give "${id}" an app screen instead`);
  }
  return {
    ok: problems.length === 0,
    missing,
    unknown: unknown.map((u) => u.id),
    stale,
    exempt,
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

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/**
 * A web-only flag written into a console page, an app feature or a route definition, read from the files themselves:
 * a key such as `webOnly: true` or `'web-only': true`. A route's flag is caught when the contract loads as well; a
 * page or a feature has no loader that would refuse one, so this is where it is caught.
 */
export function readFlagProblems(root = ROOT) {
  const problems = [];
  const files = [];
  const add = (dir, pick) => {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = pick(entry);
      if (rel && fs.existsSync(path.join(full, rel))) files.push(`${dir}/${rel}`);
    }
  };
  add('console/src/features', (entry) => (entry.isDirectory() ? `${entry.name}/index.jsx` : null));
  add('apps/owner/src/features', (entry) => (entry.isDirectory() ? `${entry.name}/index.js` : entry.name === 'index.js' ? 'index.js' : null));
  add('src/contracts/api', (entry) => (entry.isFile() && entry.name.endsWith('.js') ? entry.name : null));
  const key = /(?:^|[{,\s])(?:(['"])([^'"\n]{2,40})\1|([A-Za-z_$][\w$-]*))\s*:/g;
  for (const rel of files) {
    const text = withoutComments(fs.readFileSync(path.join(root, rel), 'utf8'));
    for (const match of text.matchAll(key)) {
      const field = match[2] ?? match[3];
      if (isWebOnlyField(field)) problems.push(`${rel} has a "${field}" flag: there is no web-only flag. Every seller route and console page needs an app screen`);
    }
  }
  return [...new Set(problems)];
}

/** Everything the check needs, read from the repository. A route contract that does not load is a problem, named. */
export async function gather(root = ROOT) {
  const readProblems = [];
  let contract = { routeList: [] };
  try {
    contract = await import(pathToFileURL(path.join(root, 'src/contracts/api/index.js')).href);
  } catch (error) {
    readProblems.push(`The route contract (src/contracts/api) did not load: ${error.message}`);
  }
  const app = readAppFeatures(root);
  const consolePages = readConsolePages(root);
  const routes = (contract.routeList ?? []).map((route) => ({ ...route }));
  if (Array.isArray(contract.CONSOLE_ONLY_ROUTES)) {
    const flagged = routes.filter((route) => route.consoleOnly === true).map((route) => route.id).sort();
    if (JSON.stringify(flagged) !== JSON.stringify([...contract.CONSOLE_ONLY_ROUTES].sort())) readProblems.push('CONSOLE_ONLY_ROUTES is not the list of routes flagged consoleOnly');
  }
  return {
    routes,
    pages: consolePages.pages,
    features: app.features,
    pending: readPending(root),
    readProblems: [...readProblems, ...app.problems, ...consolePages.problems, ...readFlagProblems(root)],
  };
}

const USAGE = 'Usage: node tools/parity-check.mjs [--root <dir>]';

/** The command line: the check, always strict. Answers the exit code. */
export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let root = ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--strict') continue;
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else {
      error(`parity: unknown option "${argv[i]}". ${USAGE}`);
      return 2;
    }
  }
  const input = await gather(root);
  const result = checkParity({ ...input, strict: true });
  const problems = [...input.readProblems, ...result.problems];
  for (const problem of problems) error(problem);
  if (problems.length) {
    error(`\nparity: ${problems.length} problem(s). Every seller route and console page needs an app screen (PRD 10.4).`);
    return 1;
  }
  const { required, mapped } = result.counts;
  const notes = [
    `${result.exempt.consoleOnly.length} console-only`,
    `${result.exempt.notServed.length} not served in production${result.exempt.notServed.length ? ` (${result.exempt.notServed.join(', ')})` : ''}`,
  ];
  log(`parity: ${required} routes and pages; ${mapped} mapped to app screens. Exempt: ${notes.join(', ')}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
