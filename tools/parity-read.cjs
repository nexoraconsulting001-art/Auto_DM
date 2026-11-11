/**
 * Reads, straight from the source files, what the parity check compares (PRD 10.4): the route ids and console pages
 * each owner-app feature says it covers, and the pages each console feature registers. Reading the text keeps the
 * check free of React, React Native and a bundler, so it runs in the server's CI in a second. CommonJS, so the
 * app's jest tests can use it too: one of them checks that what is read here is what the app really registers.
 */
const fs = require('node:fs');
const path = require('node:path');

const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** The text between the bracket at `open` and its match, skipping brackets inside quotes. Null when unbalanced. */
function bracketed(text, open) {
  const end = closing(text, open);
  return end === -1 ? null : text.slice(open + 1, end);
}

/** Where the bracket at `open` closes, or -1. */
function closing(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Every `routeIds: [...]` in one file: { ids, problems }. The list must be written out as quoted strings, so that it
 * can be read without running the app: a spread, a variable or a call is a problem, named with its file.
 */
function readRouteIds(source, file = 'index.js') {
  const text = withoutComments(source);
  const ids = [];
  const problems = [];
  const pattern = /\brouteIds\s*:\s*/g;
  let match;
  let found = 0;
  while ((match = pattern.exec(text))) {
    found++;
    const at = match.index + match[0].length;
    const inner = text[at] === '[' ? bracketed(text, at) : null;
    if (inner === null) {
      problems.push(`${file}: routeIds must be a list written out in this file, such as ['orders.list', 'console:/orders']`);
      continue;
    }
    const rest = inner.replace(/'([^'\\\n]*)'|"([^"\\\n]*)"/g, (whole, single, double) => {
      ids.push(single ?? double);
      return '';
    });
    if (/[^\s,]/.test(rest)) problems.push(`${file}: routeIds may hold only quoted ids; found "${rest.replace(/[\s,]+/g, ' ').trim().slice(0, 60)}"`);
    // Nothing may be done to the list afterwards (.concat, .filter, a spread into another): what is written is what counts.
    const after = text.slice(closing(text, at) + 1).match(/^\s*(.?)/)[1];
    if (after && !',};)'.includes(after)) problems.push(`${file}: routeIds must be the list itself, with nothing applied to it`);
  }
  if (found === 0) problems.push(`${file}: no routeIds`);
  return { ids, problems };
}

/** The app's features as written: [{ name, file, routeIds }], the shell's own list included, and any problems reading them. */
function readAppFeatures(root, app = 'owner') {
  const dir = path.join(root, 'apps', app, 'src', 'features');
  const features = [];
  const problems = [];
  if (!fs.existsSync(dir)) return { features, problems: [`apps/${app}/src/features does not exist`] };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = entry.isDirectory() ? `apps/${app}/src/features/${entry.name}/index.js` : entry.name === 'index.js' ? `apps/${app}/src/features/index.js` : null;
    if (!rel) continue;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      problems.push(`${rel} does not exist: every feature folder needs an index.js`);
      continue;
    }
    const read = readRouteIds(fs.readFileSync(file, 'utf8'), rel);
    problems.push(...read.problems);
    features.push({ name: entry.isDirectory() ? entry.name : 'shell', file: rel, routeIds: read.ids });
  }
  return { features, problems };
}

/** A console page's id, as an app feature lists it: 'console:/orders/:id'; the console's first page is 'console:/'. */
const pageId = (routePath) => `console:/${String(routePath).replace(/^\/+|\/+$/g, '')}`;

/** Every page the console's features register: [{ id, feature, file }]. */
function readConsolePages(root) {
  const dir = path.join(root, 'console', 'src', 'features');
  const pages = [];
  const problems = [];
  if (!fs.existsSync(dir)) return { pages, problems: ['console/src/features does not exist'] };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const rel = `console/src/features/${entry.name}/index.jsx`;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    const start = /\broutes\s*:\s*\[/.exec(text);
    const inner = start ? bracketed(text, start.index + start[0].length - 1) : null;
    if (inner === null) {
      problems.push(`${rel}: its routes could not be read; write them out as routes: [{ path: '...', element: ... }]`);
      continue;
    }
    const found = [...inner.matchAll(/\bpath\s*:\s*(?:'([^'\n]*)'|"([^"\n]*)")|\bindex\s*:\s*true\b/g)].map((m) => pageId(m[1] ?? m[2] ?? ''));
    const routeCount = (inner.match(/\belement\s*:/g) ?? []).length;
    if (found.length !== routeCount) problems.push(`${rel}: ${routeCount} page(s) but ${found.length} path(s) could be read; give every page a quoted path`);
    for (const id of found) pages.push({ id, feature: entry.name, file: rel });
  }
  return { pages, problems };
}

module.exports = { pageId, readAppFeatures, readConsolePages, readRouteIds };
