// The checks the brand jobs run on what a build produced (apps/shopper/.maestro/support/scan-binary.mjs): no platform name and
// no other brand's name in any file of an APK or a simulator app, in either of the two ways strings are stored, and no key,
// keystore content or password in a build log. P-01, P-31, P-36.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TOOL = path.join(ROOT, 'apps/shopper/.maestro/support/scan-binary.mjs');
const { PLATFORM_TERM, readFolder, readZip, scanBuild, scanLog, termsOf } = await import(pathToFileURL(TOOL).href);
const FIXTURES = path.join(ROOT, 'tools/build-brand/fixtures');
const brandOf = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'brand.json'), 'utf8'));
const names = fs.readdirSync(FIXTURES).filter((n) => fs.existsSync(path.join(FIXTURES, n, 'brand.json')));
const [own, other] = [brandOf(names[0]), brandOf(names[1])];

/** A zip with the named entries, each stored or deflated. */
function zipOf(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const raw = Buffer.from(data);
    const body = store ? raw : zlib.deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.concat([local, nameBytes, body]);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(store ? 0 : 8, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBytes]));
    locals.push(entry);
    offset += entry.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const utf16 = (text) => Buffer.from(text, 'utf16le');
const cleanBuild = () => ({
  'AndroidManifest.xml': Buffer.concat([utf16(own.android.package), utf16(own.shortName)]),
  'classes.dex': Buffer.from(`dex\n035\0 ${own.name} some library strings`),
  'assets/index.android.bundle': Buffer.from(`hermes ${own.scheme} ${own.shopDomain}`),
  'res/icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
});

test('the platform name is written in the tool in two pieces, so the tool does not carry it', () => {
  assert.equal(PLATFORM_TERM.length, 5);
  assert.doesNotMatch(fs.readFileSync(TOOL, 'utf8'), new RegExp(PLATFORM_TERM, 'i'));
});

test('a zip is read whole, stored or deflated', () => {
  for (const store of [true, false]) {
    const entries = readZip(zipOf({ 'a/b.txt': 'hello there', 'c.bin': Buffer.from([1, 2, 3]) }, { store }));
    assert.deepEqual(entries.map((e) => e.name), ['a/b.txt', 'c.bin']);
    assert.equal(entries[0].read().toString(), 'hello there');
  }
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /not a zip/);
});

test('P-01: a build that holds only its own brand passes, and the other fixture brand\'s words are real', () => {
  const result = scanBuild(readZip(zipOf(cleanBuild())), { own, others: [other] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.files, 4);
  assert.ok(termsOf(other).length >= 3, 'the other brand has words to look for');
  assert.ok(termsOf(other).every((term) => !termsOf(own).includes(term)));
});

test('P-31: the platform name is found as plain text, as UTF-16 at either alignment, and in a file name', () => {
  const name = ['Bha', 'va'].join('');
  const cases = {
    'classes.dex': Buffer.from(`xx ${name.toLowerCase()} yy`),
    'resources.arsc': utf16(`strings ${name}`),
    'assets/odd.bin': Buffer.concat([Buffer.from([7]), utf16(`pad ${name.toUpperCase()}`)]),
    [`assets/${name}.json`]: Buffer.from('{}'),
  };
  for (const [file, data] of Object.entries(cases)) {
    const result = scanBuild(readZip(zipOf({ ...cleanBuild(), [file]: data })), { own, others: [other] });
    assert.deepEqual(result.problems, [{ file, kind: 'platform' }], file);
  }
});

test('P-01: another brand\'s name, package, scheme or address is found, in the manifest and in the bundle', () => {
  const cases = {
    'AndroidManifest.xml': utf16(other.android.package),
    'assets/index.android.bundle': Buffer.from(`x ${other.shopDomain} y`),
    'classes.dex': Buffer.from(other.name.toUpperCase()),
    'res/raw/links.json': Buffer.from(JSON.stringify({ scheme: other.scheme })),
  };
  for (const [file, data] of Object.entries(cases)) {
    const result = scanBuild(readZip(zipOf({ ...cleanBuild(), [file]: data })), { own, others: [other] });
    assert.ok(result.problems.some((p) => p.file === file && p.kind === 'other-brand'), file);
  }
});

test('a simulator app folder is scanned the same way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-ci-app-'));
  try {
    fs.mkdirSync(path.join(dir, 'Frameworks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Info.plist'), `<plist>${own.ios.bundleId}</plist>`);
    fs.writeFileSync(path.join(dir, 'Frameworks', 'main.jsbundle'), `x ${other.name} y`);
    const result = scanBuild(readFolder(dir), { own, others: [other] });
    assert.deepEqual(result.problems, [{ file: 'Frameworks/main.jsbundle', kind: 'other-brand' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P-36: a log with a private key, keystore content or the password is refused; a plain build log is not', () => {
  const secret = 'correct-horse-battery-0123456789abcdef'; // secret-scan:allow
  const keystore = `MIIK${'A1b2C3d4/+'.repeat(40)}`;
  const log = [
    '> Task :app:assembleRelease',
    'signing with the keystore',
    '-----BEGIN PRIVATE KEY-----', // secret-scan:allow
    `data ${keystore}`,
    `storePassword=${secret}`,
    'BUILD SUCCESSFUL',
  ].join('\n');
  assert.deepEqual(scanLog(log, { secrets: [secret] }).map((p) => [p.line, p.kind]), [[3, 'private-key'], [4, 'keystore-content'], [5, 'secret-value']]);
  assert.deepEqual(scanLog('> Task :app:assembleRelease\nBUILD SUCCESSFUL in 4m', { secrets: [secret] }), []);
  assert.deepEqual(scanLog(`x ${secret}`, { secrets: ['short'] }), [], 'a short value is not taken as a secret');
  assert.deepEqual(scanLog('-----BEGIN CERTIFICATE-----', {}), [], 'a certificate is public');
});

test('the tool run as the jobs run it: exit codes, and never the matched text or a secret on screen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-ci-scan-'));
  try {
    const own1 = path.join(dir, 'own.json');
    const other1 = path.join(dir, 'other.json');
    fs.writeFileSync(own1, JSON.stringify(own));
    fs.writeFileSync(other1, JSON.stringify(other));
    const run = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

    const good = path.join(dir, 'good.apk');
    fs.writeFileSync(good, zipOf(cleanBuild()));
    const ok = run(['binary', good, '--brand', own1, '--other', other1]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /looked through 4 files/);

    const bad = path.join(dir, 'bad.apk');
    fs.writeFileSync(bad, zipOf({ ...cleanBuild(), 'assets/x.bundle': `leak ${other.name} here` }));
    const failed = run(['binary', bad, '--brand', own1, '--other', other1]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /another brand is in assets\/x\.bundle/);
    assert.ok(!(failed.stdout + failed.stderr).includes(other.name), 'the matched text is not printed');

    const secret = 'sup3r-secret-keystore-pass-99'; // secret-scan:allow
    const logFile = path.join(dir, 'build.log');
    fs.writeFileSync(logFile, `line\nthe password is ${secret}\n`);
    const leaked = run(['log', logFile, '--secret', 'KEYSTORE_PASS_FOR_TEST'], { KEYSTORE_PASS_FOR_TEST: secret });
    assert.equal(leaked.status, 1);
    assert.ok(!(leaked.stdout + leaked.stderr).includes(secret), 'the secret is not printed');
    fs.writeFileSync(logFile, 'line\nBUILD SUCCESSFUL\n');
    assert.equal(run(['log', logFile, '--secret', 'KEYSTORE_PASS_FOR_TEST'], { KEYSTORE_PASS_FOR_TEST: secret }).status, 0);
    assert.equal(run([]).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
