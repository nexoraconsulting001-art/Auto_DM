import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrandFile } from '../../../src/contracts/apps.js';
import { PLATFORM_TERM, scanLog } from '../../../apps/shopper/.maestro/support/scan-binary.mjs';
import { checkLog, makeSigningKey, writeNote } from '../../../tools/showcase-build/index.mjs';
import {
  OPERATOR, ShowcaseBuildError, apiUrl, envLines, holdsSecret, installNote, iosBrandFile, orderNumber, ownerFlowEnv, readZip, verifyApkBrand,
} from '../../../tools/showcase-build/lib.mjs';
import { apkFiles, brandOf, makeZip } from './support.js';

const verify = (n, options = {}, others = [brandOf(n === 1 ? 2 : 1)]) => verifyApkBrand(readZip(makeZip(apkFiles(n, options))), brandOf(n), { others });

test('Q-11 one setting points the builds at a server: SHOWCASE_API_URL, else the runner\'s own address for the platform', () => {
  assert.equal(apiUrl('android', {}), 'http://10.0.2.2:3000');
  assert.equal(apiUrl('ios', {}), 'http://localhost:3000');
  assert.equal(apiUrl('android', { SHOWCASE_API_URL: 'https://qa.example.test/' }), 'https://qa.example.test');
  assert.equal(apiUrl('ios', { SHOWCASE_API_URL: 'http://192.0.2.10:8140' }), 'http://192.0.2.10:8140');
});

test('Q-11 the server address is an origin: no path, login, query or other scheme', () => {
  for (const bad of ['qa.example.test', 'https://qa.example.test/api', 'https://user:pw@qa.example.test', 'https://qa.example.test?x=1', 'ftp://qa.example.test']) {
    assert.throws(() => apiUrl('android', { SHOWCASE_API_URL: bad }), ShowcaseBuildError, bad);
  }
  assert.throws(() => apiUrl('windows', {}), ShowcaseBuildError);
});

test('Q-11 the iOS brand file is the Android one with the iOS block, and fits the brand file contract', () => {
  const android = brandOf(1);
  const ios = iosBrandFile(android);
  assert.equal(ios.android, null);
  assert.deepEqual(ios.ios, { bundleId: android.android.package, buildNumber: 1, teamId: '0000000000' });
  assert.ok(BrandFile.safeParse(ios).success, 'a brand file the build accepts');
  assert.ok(BrandFile.safeParse(android).success);
  assert.equal(android.ios, null, 'the input is not changed');
  assert.throws(() => iosBrandFile({ ...android, android: null }), ShowcaseBuildError);
});

test('Q-11 an APK with its own icon, name and colours and nothing of the other business passes', () => {
  for (const n of [1, 2]) {
    const result = verify(n);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  }
  // deflated entries are read the same
  const deflated = verifyApkBrand(readZip(makeZip(apkFiles(1), { deflate: true })), brandOf(1), { others: [brandOf(2)] });
  assert.equal(deflated.ok, true);
});

test('Q-11 an APK without a launcher icon, or without the brand\'s colours, fails and says which', () => {
  assert.match(verify(1, { without: ['res/mipmap-hdpi/ic_launcher.png'] }).problems.join('\n'), /launcher icon/);
  const noColours = verify(1, { without: ['resources.arsc', 'assets/index.android.bundle'] });
  assert.equal(noColours.ok, false);
  assert.match(noColours.problems.join('\n'), /splashBackground/);
  assert.match(noColours.problems.join('\n'), /colors\.primary/);
  // the other business's colours are not this business's colours
  const wrong = verifyApkBrand(readZip(makeZip(apkFiles(2))), brandOf(1), { others: [] });
  assert.equal(wrong.ok, false);
});

test('Q-11 an APK that holds the other business\'s name, package or address, or the platform\'s name, fails; the match is not printed', () => {
  const other = brandOf(2);
  for (const [label, text] of [['name', other.name], ['package', other.android.package], ['scheme', other.scheme], ['address', other.shopDomain]]) {
    const result = verify(1, { add: [{ name: 'assets/extra.json', data: `x ${text} y` }] });
    assert.equal(result.ok, false, label);
    assert.match(result.problems.join('\n'), /Another business is in assets\/extra\.json/);
    assert.ok(!result.problems.join('\n').includes(text), 'the text itself is never printed');
  }
  const utf16 = verify(1, { add: [{ name: 'res/values/strings.xml', data: Buffer.from(other.shortName + other.name, 'utf16le') }] });
  assert.equal(utf16.ok, false, 'UTF-16 strings are read too');
  const platform = verify(1, { add: [{ name: 'assets/x.txt', data: `built by ${PLATFORM_TERM}` }] });
  assert.match(platform.problems.join('\n'), /platform name is in assets\/x\.txt/);
  assert.ok(!platform.problems.join('\n').toLowerCase().includes(`by ${PLATFORM_TERM}`));
  const named = verify(1, { add: [{ name: `lib/${PLATFORM_TERM}.so`, data: 'x' }] });
  assert.equal(named.ok, false, 'a file name counts too');
});

test('Q-11 a key, a keystore or a password in a build log is found, and only where', () => {
  const pem = `-----BEGIN ${'PRIVATE'} KEY-----`;
  assert.equal(holdsSecret(`ok\n${pem}\nabc`), true);
  assert.equal(holdsSecret(`store ${'MIIK'}${'A'.repeat(300)}`), true);
  assert.equal(holdsSecret('the password is hunter2hunter2', ['hunter2hunter2']), true);
  assert.equal(holdsSecret('a normal log line', ['hunter2hunter2']), false);
  assert.equal(holdsSecret('short', ['abc']), false, 'a value too short to be a secret is not matched');
  assert.deepEqual(scanLog('fine\n' + pem).map((p) => p.line), [2]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-test-'));
  try {
    const clean = path.join(dir, 'clean.log');
    const dirty = path.join(dir, 'dirty.log');
    fs.writeFileSync(clean, 'BUILD SUCCESSFUL\n-Pandroid.injected.signing.key.password=***\n');
    fs.writeFileSync(dirty, 'oops s3cr3t-value-123\n');
    assert.doesNotThrow(() => checkLog(clean, ['s3cr3t-value-123']));
    assert.throws(() => checkLog(dirty, ['s3cr3t-value-123']), (error) => error instanceof ShowcaseBuildError && !error.message.includes('s3cr3t'));
    assert.doesNotThrow(() => checkLog(path.join(dir, 'missing.log')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Q-11 a signing key is made for the run, its password never leaves it except as a runner mask, and it is deleted', (t) => {
  if (spawnSync('keytool', ['-help'], { stdio: 'ignore' }).status !== 0) return t.skip('keytool (a JDK) is not installed here; the workflow job has one');
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  let key;
  try {
    key = makeSigningKey({ env: { GITHUB_ACTIONS: 'true' } });
  } finally {
    console.log = original;
  }
  const { ANDROID_KEYSTORE_FILE: file, ANDROID_KEYSTORE_PASSWORD: password } = key.env;
  assert.ok(fs.existsSync(file));
  assert.deepEqual(logged, [`::add-mask::${password}`], 'the only thing printed is the mask, so the runner hides the password everywhere');
  key.dispose();
  assert.equal(fs.existsSync(file), false);
});

test('Q-11 the flows are told each business by its place in the manifest, and the order numbers differ', () => {
  assert.equal(orderNumber(1), 'SC-1-1001');
  assert.notEqual(orderNumber(1), orderNumber(2));
  const env = ownerFlowEnv([
    { tenantId: 7, name: 'Alpha Goods', order: { id: 11, number: orderNumber(1) } },
    { tenantId: 8, name: 'Zeta Plants', order: { id: 12, number: orderNumber(2) } },
  ], { apiUrl: 'http://127.0.0.1:3000', whatsappUrl: 'http://127.0.0.1:9104', appHost: '10.0.2.2' });
  assert.deepEqual(Object.keys(env).sort(), ['API_URL', 'BUSINESS_1_ID', 'BUSINESS_1_NAME', 'BUSINESS_2_ID', 'BUSINESS_2_NAME', 'BUSINESS_COUNT', 'ORDER_1_ID', 'ORDER_1_NUMBER', 'ORDER_2_ID', 'ORDER_2_NUMBER', 'PHONE_OPERATOR', 'SIGN_IN_HOST', 'SIM_WHATSAPP_URL']);
  assert.equal(env.BUSINESS_2_ID, '8');
  assert.equal(env.PHONE_OPERATOR, OPERATOR.phone);
  assert.match(OPERATOR.phone, /^9\d{9}$/, 'an invented ten digit number');
});

test('Q-11 flow values are NAME=value lines and nothing else', () => {
  assert.equal(envLines({ A: '1', B_2: 'x y' }), 'A=1\nB_2=x y\n');
  assert.throws(() => envLines({ 'a b': '1' }), ShowcaseBuildError);
  assert.throws(() => envLines({ A: 'one\ntwo' }), ShowcaseBuildError);
});

test('Q-11 the install note says how to install, names no platform and holds no key', () => {
  const note = installNote({
    builds: [{ name: 'Alpha Goods', shortName: 'Alpha', package: 'app.sample.alphagoods', file: 'showcase-first.apk' }, { name: 'Zeta Plants', shortName: 'Zeta', package: 'app.sample.zetaplants', file: 'showcase-second.apk' }],
    apiUrl: 'http://10.0.2.2:3000',
    owner: { file: 'showcase-owner.apk' },
  });
  assert.match(note, /adb install -r/);
  assert.match(note, /showcase-first\.apk/);
  assert.match(note, /showcase-owner\.apk/);
  assert.match(note, /http:\/\/10\.0\.2\.2:3000/);
  assert.match(note, /SHOWCASE_API_URL/);
  assert.ok(!note.toLowerCase().includes(PLATFORM_TERM));
  assert.equal(holdsSecret(note), false);
  assert.ok(note.split('\n').length < 30, 'a short note');
});

test('Q-11 the note is written from the brand files that are there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-note-'));
  try {
    for (const [key, n] of [['first', 1], ['second', 2]]) {
      fs.mkdirSync(path.join(dir, 'brands', key), { recursive: true });
      fs.writeFileSync(path.join(dir, 'brands', key, 'brand.json'), JSON.stringify(brandOf(n)));
    }
    fs.mkdirSync(path.join(dir, 'apks'));
    fs.writeFileSync(path.join(dir, 'apks', 'showcase-owner.apk'), 'x');
    const out = path.join(dir, 'apks', 'INSTALL.txt');
    writeNote({ folder: path.join(dir, 'brands'), apkDir: path.join(dir, 'apks'), out });
    const text = fs.readFileSync(out, 'utf8');
    assert.match(text, /Alpha Goods/);
    assert.match(text, /showcase-second\.apk/);
    assert.match(text, /Owner app: showcase-owner\.apk/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
