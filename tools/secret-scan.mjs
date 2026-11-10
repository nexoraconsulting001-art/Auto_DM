/**
 * `npm run secret-scan`: fails if a tracked file holds a token-like secret, a private key or the VM's address.
 * Findings show the file, line and rule, never the value. Run it before every push: this repo is public.
 *
 * A line with the marker `secret-scan:allow` is exempt from the token rules (for made-up fixture values).
 * Nothing exempts the VM address. Only a hash of it is kept here, so this file does not publish it either.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VM_ADDRESS_HASHES = new Set(['e5578837090ee131a78dc57052a9c9c192eb96e14141f972938e68459559ecb3']);
const ALLOW_MARKER = 'secret-scan:allow';
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const TOKEN_RULES = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ['Slack token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['Razorpay key', /\brzp_(?:live|test)_[A-Za-z0-9]{10,}\b/],
  ['Meta access token', /\bEAA[A-Za-z0-9]{40,}\b|\bIG(?:AA|QV|QW)[A-Za-z0-9_-]{40,}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`<>{}$]+:(?!password@)[^\s/:@'"`<>{}$]{8,}@/i],
];

// name = "value", name: 'value', name `value`, where the value looks random rather than like a word or placeholder.
const NAMED_SECRET = /(?:secret|token|passw(?:or)?d|api[_ -]?key|private[_ -]?key|access[_ -]?key)[\w-]*["'`]?\s*(?:[:=]\s*["'`]?|["'`])([A-Za-z0-9_+/=-]{16,})/gi;
const PLACEHOLDER = /example|change[-_]?me|placeholder|your[-_]|xxxx|dummy|fake|sample|redacted/i;
const WORDS_OR_CONSTANT = /^(?:[a-z]+(?:[-_][a-z]+)+|[A-Z0-9]+(?:_[A-Z0-9]+)+)$/; // some-words or SOME_NAME_2

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((sum, n) => sum - (n / s.length) * Math.log2(n / s.length), 0);
}

const looksRandom = (value) => /\d/.test(value) && /[A-Za-z]/.test(value) && !PLACEHOLDER.test(value) && !WORDS_OR_CONSTANT.test(value) && entropy(value) >= 3.2;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const IP_LIKE = /(?<!\d)(?=(\d{1,3}([.-])\d{1,3}\2\d{1,3}\2\d{1,3})(?!\d))/g; // a lookahead, so overlapping runs are all seen

function holdsAddress(text, hashes) {
  for (const m of text.matchAll(IP_LIKE)) if (hashes.has(sha256(m[1].replace(/-/g, '.')))) return true;
  return false;
}

/** The rule names broken by one file. Lock files only get the address check. */
export function scanText(file, text, { addressHashes = VM_ADDRESS_HASHES } = {}) {
  const findings = [];
  if (holdsAddress(file, addressHashes)) findings.push({ file, line: 0, rule: 'VM address' });
  const lockFile = /(^|\/)package-lock\.json$/.test(file);
  text.split(/\r?\n/).forEach((line, index) => {
    const at = index + 1;
    if (holdsAddress(line, addressHashes)) findings.push({ file, line: at, rule: 'VM address' });
    if (lockFile || line.includes(ALLOW_MARKER)) return;
    for (const [rule, pattern] of TOKEN_RULES) if (pattern.test(line)) findings.push({ file, line: at, rule });
    for (const m of line.matchAll(NAMED_SECRET)) {
      if (looksRandom(m[1])) findings.push({ file, line: at, rule: 'named secret with a random-looking value' });
    }
  });
  return findings;
}

function scanRepo(root) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const findings = [];
  let scanned = 0;
  for (const file of tracked) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size > MAX_FILE_BYTES) continue;
    const data = fs.readFileSync(full);
    if (data.subarray(0, 8000).includes(0)) continue; // binary
    scanned++;
    findings.push(...scanText(file, data.toString('utf8')));
  }
  return { scanned, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const { scanned, findings } = scanRepo(root);
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}`);
  console.log(`secret-scan: ${scanned} files, ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
}
