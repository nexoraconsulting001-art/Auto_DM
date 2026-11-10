/**
 * `npm run policy-check`: one structure for every business (PRD 5.18, F-97). Fails when product code checks a particular
 * business to change what it does: comparing a business's id, slug or name with a fixed value, a fixed tenant_id in SQL, or a
 * sample business's name in code. Differences between businesses live in data (brand kit, settings, blocks, entitlements and
 * feature flags), never in code. Comments are not checked; seed data, tests and tools are not product code.
 *
 *   node tools/policy-check.mjs [folder ...]     default: src, console/src, shared
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FOLDERS = ['src', 'console/src', 'shared'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.vite']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.sql']);

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
  { name: 'sample-business', message: 'names a sample business in code', pattern: /mehta\s*mart|mehtamart|plant\s*store|plantstore|offerwalebaba|mehtamartmhm/i },
]);

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

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

/** Every finding under the folders, relative to the repo. */
export function checkFolders(folders = DEFAULT_FOLDERS, root = ROOT) {
  const findings = [];
  for (const folder of folders) {
    for (const file of walk(path.resolve(root, folder))) findings.push(...checkSource(fs.readFileSync(file, 'utf8'), path.relative(root, file).split(path.sep).join('/')));
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folders = process.argv.slice(2);
  const findings = checkFolders(folders.length ? folders : DEFAULT_FOLDERS);
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.message} (${f.rule}): ${f.text}`);
  if (findings.length) {
    console.error(`\npolicy-check: ${findings.length} place(s) treat one business differently in code. Put the difference in data: the brand kit, settings, blocks, entitlements or a feature flag (PRD 5.18).`);
    process.exit(1);
  }
  console.log('policy-check: no code checks a particular business.');
}
