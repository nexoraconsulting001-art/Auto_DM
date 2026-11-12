/**
 * `npm run policy-check`: one structure for every business (PRD 5.18, F-97). Fails when product code checks a particular
 * business to change what it does: comparing a business's id, slug or name with a fixed value, a fixed tenant_id in SQL, or a
 * sample business's name in code. Differences between businesses live in data (brand kit, settings, blocks, entitlements and
 * feature flags), never in code. Comments are not checked; seed data, tests and tools are not product code.
 *
 * The apps are held to more (PRD 10.1, P-03): nothing under apps/ or packages/ may name a business at all, in code, a
 * comment, a string, a test, a config file or a Maestro flow. One binary serves every business, and a shopper app
 * takes its brand from the brand kit at build time, never from the source tree.
 *
 * The shopper app is held to more again (PRD 10.7, P-01, P-31). Under apps/shopper, packages/store-client and packages/pay:
 *   - the platform's name appears only as the scope of a workspace package ('@bhava/ui'), never in a string, a comment or a test
 *   - no colour is written out: every colour comes from the build's brand file
 * And nothing under apps/ or packages/ may hold a value of any brand file in tools/build-brand/fixtures (its name, short
 * name, link scheme, package, bundle id, domain or team id), so a fixture brand can never leak into the source tree either.
 *
 *   node tools/policy-check.mjs [folder ...]     default: src, console/src, shared, apps, packages, tools/build-brand
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FOLDERS = ['src', 'console/src', 'shared', 'apps', 'packages', 'tools/build-brand'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.vite', 'android', 'ios', '.expo']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.sql']);
/** Under apps/ and packages/ every text file is read for a business's name, comments and all. */
const APP_FOLDERS = /^(apps|packages)(\/|$)/;
const APP_TEXT = new Set([...EXTENSIONS, '.json', '.yaml', '.yml', '.md', '.txt', '.xml', '.plist', '.html', '.css', '.gradle', '.properties', '.swift', '.kt', '.java']);
const BRAND_NAMES = /mehta\s*mart|mehtamart|plant\s*store|plantstore|offerwalebaba|mehtamartmhm/i;

/** The shopper app and the two packages only it uses. */
const SHOPPER_FOLDERS = /^(apps\/shopper|packages\/(store-client|pay))(\/|$)/;
const PLATFORM_WORD = /bhava/i;
const PACKAGE_SCOPE = /@bhava\/[a-z][a-z0-9-]*/g;
const COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9A-Za-z_-])/;
const COLOUR_FILES = new Set([...EXTENSIONS, '.json']);
const BRAND_FIXTURES = 'tools/build-brand/fixtures';

const WHO = String.raw`(?:tenant|business|shop|store|seller|req\.tenant|ctx\.tenant|currentTenant\(\))`;
const FIELD = String.raw`(?:id|slug|name|domain|tenantId|tenant_id)`;
const LITERAL = String.raw`(?:'[^']*'|"[^"]*"|\x60[^\x60$]*\x60|\d+)`;

/** Each rule: a name, what it means, and a pattern over one line with comments removed. */
export const POLICY_RULES = Object.freeze([
  { name: 'compares-business', message: 'compares a business with a fixed value', pattern: new RegExp(String.raw`\b${WHO}\??\.${FIELD}\s*[!=]==?\s*${LITERAL}`, 'i') },
  { name: 'compares-business', message: 'compares a business with a fixed value', pattern: new RegExp(String.raw`${LITERAL}\s*[!=]==?\s*\b${WHO}\??\.${FIELD}\b`, 'i') },
  { name: 'compares-business', message: 'compares the current business id with a fixed number', pattern: /\btenantId\(\)\s*[!=]==?\s*\d+|\d+\s*[!=]==?\s*tenantId\(\)/ },
  { name: 'switch-on-business', message: 'switches on a business', pattern: new RegExp(String.raw`\bswitch\s*\(\s*${WHO}\??\.${FIELD}\s*\)`, 'i') },
  { name: 'business-list', message: 'checks a business against a fixed list', pattern: new RegExp(String.raw`\[\s*${LITERAL}(?:\s*,\s*${LITERAL})*\s*\]\s*\.includes\(\s*${WHO}\??\.${FIELD}\s*\)`, 'i') },
  { name: 'fixed-tenant-sql', message: 'names a fixed business in SQL', pattern: /\btenant_id\s*(?:=|<>|!=|IN\s*\()\s*\(?\s*\d+/i },
  { name: 'sample-business', message: 'names a sample business in code', pattern: BRAND_NAMES },
]);

/** Findings for a file under apps/ or packages/: any line that names a business, wherever on the line it is. */
export function checkBrandNames(text, file = 'source.js') {
  const findings = [];
  String(text).split('\n').forEach((line, index) => {
    if (BRAND_NAMES.test(line)) findings.push({ file, line: index + 1, rule: 'business-name-in-app', message: "names a business in the apps' source", text: line.trim().slice(0, 160) });
  });
  return findings;
}

/** Findings for a file of the shopper app: the platform's name outside a package scope, or a colour written out. */
export function checkShopperSource(text, file = 'source.js') {
  const findings = [];
  const colours = COLOUR_FILES.has(path.extname(file));
  String(text).split('\n').forEach((line, index) => {
    if (PLATFORM_WORD.test(line.replace(PACKAGE_SCOPE, ''))) findings.push({ file, line: index + 1, rule: 'platform-name-in-shopper-app', message: "names the platform in the shopper app's source", text: line.trim().slice(0, 160) });
    else if (colours && COLOUR.test(line)) findings.push({ file, line: index + 1, rule: 'colour-in-shopper-app', message: 'writes a colour out in the shopper app: colours come from the brand file', text: line.trim().slice(0, 160) });
  });
  return findings;
}

/** What identifies each fixture brand: the values no file under apps/ or packages/ may hold. */
export function brandValues(root = ROOT) {
  const dir = path.join(root, BRAND_FIXTURES);
  if (!fs.existsSync(dir)) return [];
  const values = new Set();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name, 'brand.json');
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    let brand;
    try {
      brand = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const value of [entry.name, brand.name, brand.shortName, brand.scheme, brand.android?.package, brand.ios?.bundleId, brand.shopDomain, brand.ios?.teamId]) {
      if (typeof value === 'string' && value.trim().length >= 4) values.add(value.trim().toLowerCase());
    }
  }
  return [...values];
}

/** Findings for a file under apps/ or packages/: any line that holds a brand file's value. */
export function checkBrandValues(text, file, values) {
  if (!values.length) return [];
  const findings = [];
  String(text).split('\n').forEach((line, index) => {
    const lower = line.toLowerCase();
    if (values.some((value) => lower.includes(value))) findings.push({ file, line: index + 1, rule: 'brand-in-app-source', message: "holds a brand's own value in the apps' source: it belongs in the brand file", text: line.trim().slice(0, 160) });
  });
  return findings;
}

/** The text with comments blanked out, keeping line numbers. Strings are left alone, so a URL's // survives. */
export function withoutComments(text, extension) {
  if (extension === '.sql') return text.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const block = text.slice(i, end === -1 ? text.length : end + 2);
      out += block.replace(/[^\n]/g, ' ');
      i += block.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Findings for one file's text: [{ file, line, rule, message, text }]. */
export function checkSource(text, file = 'source.js') {
  const extension = path.extname(file);
  const lines = withoutComments(String(text), extension).split('\n');
  const findings = [];
  lines.forEach((line, index) => {
    for (const rule of POLICY_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ file, line: index + 1, rule: rule.name, message: rule.message, text: line.trim().slice(0, 160) });
        break;
      }
    }
  });
  return findings;
}

function* walk(dir, extensions = EXTENSIONS) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, extensions);
    else if (extensions.has(path.extname(entry.name))) yield full;
  }
}

/** Every finding under the folders, relative to the repo. */
export function checkFolders(folders = DEFAULT_FOLDERS, root = ROOT) {
  const findings = [];
  const relative = (file) => path.relative(root, file).split(path.sep).join('/');
  const brands = brandValues(root);
  for (const folder of folders) {
    const inApps = APP_FOLDERS.test(relative(path.resolve(root, folder)));
    for (const file of walk(path.resolve(root, folder), inApps ? APP_TEXT : EXTENSIONS)) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = relative(file);
      const code = EXTENSIONS.has(path.extname(file)) ? checkSource(text, rel) : [];
      const named = inApps ? checkBrandNames(text, rel).filter((f) => !code.some((c) => c.line === f.line)) : [];
      const taken = new Set([...code, ...named].map((f) => f.line));
      const shopper = SHOPPER_FOLDERS.test(rel) ? checkShopperSource(text, rel).filter((f) => !taken.has(f.line)) : [];
      for (const f of shopper) taken.add(f.line);
      const branded = inApps ? checkBrandValues(text, rel, brands).filter((f) => !taken.has(f.line)) : [];
      findings.push(...code, ...named, ...shopper, ...branded);
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folders = process.argv.slice(2);
  const findings = checkFolders(folders.length ? folders : DEFAULT_FOLDERS);
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.message} (${f.rule}): ${f.text}`);
  if (findings.length) {
    console.error(`\npolicy-check: ${findings.length} place(s) treat one business differently in code, or put a brand or the platform's name where it may not be. Put the difference in data: the brand kit, the brand file, settings, blocks, entitlements or a feature flag (PRD 5.18, 10.1, 10.7).`);
    process.exit(1);
  }
  console.log('policy-check: no code checks a particular business.');
}
