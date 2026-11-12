import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { buildBrand } from '../../../tools/build-brand/index.mjs';
import { runFromDatabase } from '../../../src/modules/app-builds/cli.js';
import { checkGenerated, generateBrandImages, measureImage } from '../../../src/modules/app-builds/images.js';
import { easFailure, serverEnv } from '../../../src/modules/app-builds/pipeline.js';
import { shopperRuntime } from '../../../src/modules/app-builds/service.js';

// The build tool's side of the pipeline track: the validate step takes the pipeline's own checks, the images made with sharp
// pass every spec, the commands see a short list of settings, and the command line refuses what is not a business's slug.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'));
const config = {
  appName: 'Kesar <b>Kitchen</b>', shortName: 'Kesar', shopDomain: 'shop.kesar.example', supportEmail: 'help@kesar.example', privacyUrl: 'https://shop.kesar.example/privacy',
  iconMediaId: 'x', urlScheme: 'kesarkitchen', androidPackage: 'in.kesar.shop', playSigningSha256: [Array.from({ length: 32 }, () => 'AB').join(':')],
};

test('the validate step takes the pipeline\'s own problems, each once, and nothing is generated or built after them', async () => {
  let generated = 0;
  let built = 0;
  const report = await buildBrand('kesar-kitchen', {
    cwd: tmp(), outDir: 'out', log: () => {}, platforms: ['android'], driver: 'eas',
    loadBySlug: async () => ({ config, kit: { colors: { primary: '#112233' } }, hosts: ['shop.kesar.example'], sourceDir: tmp() }),
    moreProblems: async () => [{ field: 'appName', code: 'markup', message: 'Use plain text.', platform: null }, { field: 'appName', code: 'markup', message: 'Use plain text.', platform: null }],
    generateAssets: async () => { generated += 1; return { assets: {}, fonts: [] }; },
    easBuild: async () => { built += 1; return { status: 'built' }; },
  });
  assert.equal(report.ok, false);
  assert.equal(report.step, 'validate');
  assert.equal(report.field, 'appName');
  assert.equal(report.problems.filter((p) => p.field === 'appName').length, 1);
  assert.equal(generated + built, 0);
});

test('the images made from a photo-like JPEG or a transparent logo pass every spec; the notification icon is one colour on transparent', async () => {
  const jpeg = await sharp({ create: { width: 1400, height: 1400, channels: 3, background: '#7A1F3D' } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1400"><rect x="200" y="200" width="1000" height="1000" fill="#F5B83D"/></svg>') }]).jpeg().toBuffer();
  const logo = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="512" cy="512" r="300" fill="#3B2FC9"/></svg>')).png().toBuffer();
  for (const icon of [jpeg, logo]) {
    const images = await generateBrandImages({ icon, ground: '#F6F5F1', background: '#3B2FC9' });
    assert.deepEqual(await checkGenerated(images), []);
    const note = await measureImage(images.notificationIcon);
    assert.equal(note.hasAlpha, true);
    assert.equal(note.monochrome, true);
    assert.equal((await measureImage(images.icon)).hasAlpha, false);
    assert.deepEqual([(await measureImage(images.featureGraphic)).width, (await measureImage(images.featureGraphic)).height], [1024, 500]);
  }
  // A splash image of its own is fitted into the square, whatever its shape.
  const splash = await sharp({ create: { width: 800, height: 1600, channels: 3, background: '#FFFFFF' } }).png().toBuffer();
  const withSplash = await generateBrandImages({ icon: logo, splash });
  assert.deepEqual(await checkGenerated(withSplash), []);
  await assert.rejects(generateBrandImages({ icon: Buffer.from('not an image') }));
});

test('a build\'s commands see only the settings a build needs; the build service\'s failures are plain sentences', () => {
  const env = serverEnv({ PATH: '/usr/bin', HOME: '/home/x', DATABASE_URL: 'postgres://u:p@h/db', DATA_KEY: 'k', EXPO_TOKEN: 't', SESSION_SECRET: 's', JAVA_HOME: '/jdk' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'JAVA_HOME', 'PATH']);
  for (const kind of ['not_configured', 'timeout', 'network', 'server', 'throttled', 'malformed', 'rejected', 'auth', undefined]) {
    const sentence = easFailure({ kind, message: 'eas call failed http://127.0.0.1:1234 Bearer abc' });
    assert.ok(sentence.length > 10 && !/127\.0\.0\.1|Bearer|http/.test(sentence), sentence);
  }
});

test('the first runtime is the shopper app\'s own version, and the command line refuses anything that is not a slug before opening a database', async () => {
  const first = shopperRuntime();
  assert.match(first.appVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(first.runtimeVersion, first.appVersion);
  assert.match(first.fingerprint, /^fp[0-9a-f]{30}$/);
  assert.equal(shopperRuntime(tmp()).appVersion, '1.0.0', 'With no app source the placeholder is 1.0.0');
  const printed = [];
  for (const slug of ['Bad Slug!', '../etc', '', 'a'.repeat(80)]) assert.equal((await runFromDatabase(slug, {}, (l) => printed.push(l))).ok, false);
  assert.ok(printed.every((l) => /slug/.test(l)));
});
