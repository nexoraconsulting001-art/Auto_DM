/**
 * Checks on what a brand build produced, run by .github/workflows/brand-apps.yml on the APK and the iOS simulator app, and
 * on the build's log (PRD 10.1, P-01, P-31, P-36):
 *
 *   node scan-binary.mjs binary <app.apk | App.app folder> --brand <brand.json> [--other <brand.json>]...
 *       Looks through every file of the build (names, manifest, resources, bundled code, native libraries) as plain bytes and
 *       as UTF-16, the two ways strings are stored, for the platform name and for any other brand's name, package, link
 *       scheme or address. Fails with the file, never with the text around a match.
 *   node scan-binary.mjs log <file> [--secret <ENV_NAME>]...
 *       Fails when a build log holds a private key, keystore content, or the value of a named setting (the keystore
 *       password). Prints only where, never what.
 *
 * No dependencies beyond node: a zip is read here, from its central directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** The platform name, written so this file does not carry it in one piece. */
export const PLATFORM_TERM = ['bha', 'va'].join('');
const MAX_FILE = 256 * 1024 * 1024;

/** Every entry of a zip: [{ name, read() }]. Stored and deflated entries; anything else is an error, not a skip. */
export function readZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a zip file: no end record');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip directory is damaged');
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      read() {
        if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: damaged local header`);
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const data = buffer.subarray(start, start + size);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_FILE });
        throw new Error(`${name}: unsupported compression ${method}`);
      },
    });
  }
  return entries;
}

/** Files of a folder tree as the same entries a zip gives. */
export function readFolder(folder) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ name: path.relative(folder, full).split(path.sep).join('/'), read: () => fs.readFileSync(full) });
    }
  };
  walk(folder);
  return out;
}

/** The words that must not be in another brand's build, taken from a brand file. */
export function termsOf(brand) {
  return [brand.name, brand.shortName, brand.android?.package, brand.ios?.bundleId, brand.scheme, brand.shopDomain, ...(brand.linkHosts ?? [])]
    .filter((term) => typeof term === 'string' && term.length >= 4)
    .map((term) => term.toLowerCase());
}

const lowerLatin = (buffer) => buffer.toString('latin1').toLowerCase();
const lowerUtf16 = (buffer, offset) => buffer.subarray(offset, offset + ((buffer.length - offset) & ~1)).toString('utf16le').toLowerCase();

/** Which of `terms` are in a file's name or bytes, as plain text or as UTF-16 at either alignment. */
export function termsIn(name, buffer, terms) {
  const found = new Set();
  const lowerName = name.toLowerCase();
  const texts = [lowerLatin(buffer), lowerUtf16(buffer, 0), lowerUtf16(buffer, 1)];
  for (const term of terms) if (lowerName.includes(term) || texts.some((text) => text.includes(term))) found.add(term);
  return [...found];
}

/** Looks through a build. Answers { files, problems: [{ file, kind }] }, kind 'platform' or 'other-brand'; never the matched words. */
export function scanBuild(entries, { own, others = [] }) {
  const ownTerms = termsOf(own);
  // A word another brand shares with this one (a common domain suffix, say) says nothing about a mix-up.
  const otherTerms = [...new Set(others.flatMap(termsOf))].filter((term) => !ownTerms.some((mine) => mine.includes(term) || term.includes(mine)));
  const problems = [];
  let files = 0;
  for (const entry of entries) {
    files += 1;
    const buffer = entry.read();
    if (termsIn(entry.name, buffer, [PLATFORM_TERM]).length) problems.push({ file: entry.name, kind: 'platform' });
    if (otherTerms.length && termsIn(entry.name, buffer, otherTerms).length) problems.push({ file: entry.name, kind: 'other-brand' });
  }
  return { files, problems };
}

const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
// A PKCS12 or JKS keystore, as base64 on one line.
const KEYSTORE_BASE64 = /(?:MIIK|MIIJ|MIIL|\/u3\+7QAAAA)[A-Za-z0-9+/]{200,}/;
const MIN_SECRET = 8;

/** Looks through a log. `secrets` are values (a keystore password); answers [{ line, kind }]. */
export function scanLog(text, { secrets = [] } = {}) {
  const problems = [];
  const values = secrets.filter((value) => typeof value === 'string' && value.length >= MIN_SECRET);
  String(text).split(/\r?\n/).forEach((line, index) => {
    if (PRIVATE_KEY.test(line)) problems.push({ line: index + 1, kind: 'private-key' });
    else if (KEYSTORE_BASE64.test(line)) problems.push({ line: index + 1, kind: 'keystore-content' });
    else if (values.some((value) => line.includes(value))) problems.push({ line: index + 1, kind: 'secret-value' });
  });
  return problems;
}

function entriesOf(target) {
  return fs.statSync(target).isDirectory() ? readFolder(target) : readZip(fs.readFileSync(target));
}

const readBrand = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

function main(argv) {
  const [kind, target, ...rest] = argv;
  const all = (name) => rest.flatMap((value, i) => (rest[i - 1] === name ? [value] : []));
  if (kind === 'binary' && target && all('--brand').length === 1) {
    const result = scanBuild(entriesOf(target), { own: readBrand(all('--brand')[0]), others: all('--other').map(readBrand) });
    console.log(`scan-binary: looked through ${result.files} files`);
    for (const problem of result.problems) console.error(`scan-binary: ${problem.kind === 'platform' ? 'the platform name' : 'another brand'} is in ${problem.file}`);
    return result.problems.length ? 1 : 0;
  }
  if (kind === 'log' && target) {
    const secrets = all('--secret').map((name) => process.env[name]);
    const problems = scanLog(fs.readFileSync(target, 'utf8'), { secrets });
    console.log(`scan-binary: checked the log (${problems.length ? 'problems' : 'clean'})`);
    for (const problem of problems) console.error(`scan-binary: ${problem.kind} on line ${problem.line} of the build log`);
    return problems.length ? 1 : 0;
  }
  console.error('Usage: node scan-binary.mjs binary <apk|app folder> --brand <brand.json> [--other <brand.json>]...\n       node scan-binary.mjs log <file> [--secret <ENV_NAME>]...');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
