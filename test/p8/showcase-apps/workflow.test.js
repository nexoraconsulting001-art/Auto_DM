import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { PLATFORM_TERM } from '../../../apps/shopper/.maestro/support/scan-binary.mjs';
import { read, root } from './support.js';

const workflow = yaml.load(read('.github/workflows/showcase.yml'));
const flowDirs = { shopper: 'apps/shopper/.maestro/showcase', owner: 'apps/owner/.maestro/showcase' };
const flowFiles = (dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.yaml')).sort();
const stepsOf = (job) => workflow.jobs[job].steps;
const runText = (job) => stepsOf(job).map((step) => `${step.run ?? ''}\n${step.with?.script ?? ''}`).join('\n');
const manifest = JSON.parse(read('seed/showcase/manifest.json'));

test('Q-11 the workflow needs no account and no secret: no secrets context, no token, no store key', () => {
  const text = read('.github/workflows/showcase.yml');
  assert.ok(!/\bsecrets\./.test(text), 'nothing reads a repository secret');
  assert.ok(!/EXPO_TOKEN|GITHUB_TOKEN|ANDROID_KEYSTORE_PASSWORD|KEY_PASS\b/.test(text), 'no token or key password is named');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(!/eas (build|submit)|--driver eas/.test(text), 'the local driver only: nothing goes to a build service');
  assert.ok(!text.toLowerCase().includes(PLATFORM_TERM) || /OWNER_APP_ID: com\.\w+\.business/.test(text), 'the platform name appears only as the owner app\'s own id');
});

test('Q-11 the workflow has every stage, and the last job passes only when every other one did', () => {
  const jobs = Object.keys(workflow.jobs);
  for (const job of ['seed', 'android', 'owner', 'ios', 'shopper-flows', 'owner-flows', 'package', 'ready']) assert.ok(jobs.includes(job), job);
  const ready = workflow.jobs.ready;
  assert.equal(ready.if, 'always()', 'it runs even when a job failed, so it can fail');
  assert.deepEqual([...ready.needs].sort(), jobs.filter((job) => job !== 'ready').sort(), 'it waits for every other job');
  assert.match(ready.steps[0].run, /result !== "success"/);
  assert.match(ready.steps[0].run, /process\.exit\(failed\.length \? 1 : 0\)/);
  // nothing can be skipped quietly: a build or flow step never ignores its own failure
  const text = read('.github/workflows/showcase.yml');
  assert.ok(!/continue-on-error|\|\| true(?!\s*\n?\s*tail)/.test(text.replace(/kill "\$\(cat[^)]*\)" \|\| true/g, '').replace(/tail -n \d+ "\$RUNNER_TEMP\/server\.log" \|\| true/g, '')), 'no step ignores its failure');
});

test('Q-11 the stages need what they use: APKs after the brand files, flows after the APK they install, packaging after every flow', () => {
  const needs = (job) => [].concat(workflow.jobs[job].needs ?? []);
  assert.ok(needs('android').includes('seed'));
  assert.ok(needs('ios').includes('seed'));
  assert.ok(needs('shopper-flows').includes('android') && needs('shopper-flows').includes('seed'));
  assert.ok(needs('owner-flows').includes('owner'));
  for (const job of ['shopper-flows', 'owner-flows', 'ios']) assert.ok(needs('package').includes(job), job);
  assert.equal(workflow.jobs.ios['runs-on'], 'macos-26', 'iOS compiles on the macOS runner');
  for (const job of ['android', 'ios', 'shopper-flows']) assert.equal(workflow.jobs[job].strategy.matrix.key, '${{ fromJSON(needs.seed.outputs.keys) }}', `${job} runs once per business of the manifest`);
  assert.equal(workflow.jobs.seed.outputs.keys, '${{ steps.list.outputs.keys }}');
});

test('Q-11 the brand files are made at build time from the database and never committed', () => {
  const seed = runText('seed');
  assert.match(seed, /showcase-build\/index\.mjs brands/);
  assert.match(seed, /git status --porcelain/, 'the job checks nothing was written into the repository');
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n');
  const own = tracked.filter((file) => /^(tools\/showcase-build|apps\/(shopper|owner)\/\.maestro\/showcase|test\/p8\/showcase-apps)\//.test(file));
  assert.ok(own.length === 0 || own.every((file) => !/brand(-ios)?\.json$/.test(file)), 'no brand file among this track\'s files');
  assert.ok(!tracked.some((file) => /(^|\/)brand(-ios)?\.json$/.test(file) && !/fixtures|test\//.test(file)), 'no exported brand file is tracked');
  assert.ok(!tracked.some((file) => /\.(keystore|jks|p12|pfx|pem)$/i.test(file)), 'no keystore or key is tracked');
  const keys = stepsOf('seed').find((step) => step.uses?.startsWith('actions/upload-artifact'));
  assert.equal(keys.with.name, 'showcase-brand-files');
  assert.ok(keys.with['retention-days'] <= 7, 'brand files do not stay long');
});

test('Q-11 an Android build makes its own throwaway key through the tool, not through the workflow', () => {
  const android = runText('android');
  assert.match(android, /showcase-build\/index\.mjs build .* --platform android/);
  assert.ok(!/keytool|keystore/i.test(android), 'the workflow holds no key step: the tool makes, masks and deletes the key');
  const tool = read('tools/showcase-build/index.mjs');
  assert.match(tool, /::add-mask::/);
  assert.match(tool, /dispose/);
  assert.match(tool, /checkLog\(logFile/, 'the build log is checked for a key before it is shown');
  assert.ok(!/console\.(log|error)\([^)]*(password|storePassword|keystore)/i.test(tool.replace(/::add-mask::\$\{password\}/, '')), 'the password is never printed except as the runner mask');
});

test('Q-11 the checked APK is uploaded as an artifact with an install note', () => {
  const uploads = stepsOf('package').filter((step) => step.uses?.startsWith('actions/upload-artifact'));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].with.name, 'showcase-apks');
  assert.equal(uploads[0].with['if-no-files-found'], 'error');
  assert.match(runText('package'), /showcase-build\/index\.mjs note .*INSTALL.txt/);
  const collects = stepsOf('package').find((step) => step.with?.pattern === 'showcase-apk-*');
  assert.equal(collects.with['merge-multiple'], true);
  for (const job of ['android', 'owner']) {
    const up = stepsOf(job).find((step) => step.uses?.startsWith('actions/upload-artifact'));
    assert.match(up.with.name, /^showcase-apk-/);
    assert.equal(up.with['if-no-files-found'], 'error', 'a build that made no APK fails');
  }
});

test('Q-11 every server address is one setting, SHOWCASE_API_URL, and the runner\'s own servers are simulators', () => {
  for (const job of ['android', 'owner', 'ios']) {
    const built = stepsOf(job).filter((step) => step.env?.SHOWCASE_API_URL);
    assert.ok(built.length >= 1, `${job} builds against SHOWCASE_API_URL`);
  }
  assert.match(stepsOf('android').find((step) => step.env?.SHOWCASE_API_URL).env.SHOWCASE_API_URL, /^http:\/\/10\.0\.2\.2:/, 'an emulator reaches the machine at its own name');
  assert.match(stepsOf('ios').find((step) => step.env?.SHOWCASE_API_URL).env.SHOWCASE_API_URL, /^http:\/\/localhost:/);
  const text = read('.github/workflows/showcase.yml');
  assert.ok(!/https?:\/\/(?!10\.0\.2\.2|localhost|127\.0\.0\.1|get\.maestro\.mobile\.dev)[a-z0-9.-]+\.[a-z]{2,}/i.test(text.replace(/\$\{\{[^}]*\}\}/g, '')), 'no address of any service in the workflow but the runner\'s own and the Maestro installer');
});

test('Q-11 the workflow and the build tools name no sample business: they come from the manifest', () => {
  const names = [];
  for (const { file } of manifest.businesses) {
    const seed = JSON.parse(read(path.posix.join('seed/showcase', file)));
    names.push(seed.business.name, seed.business.slug, seed.app.urlScheme, seed.app.androidPackage);
  }
  const files = ['.github/workflows/showcase.yml', ...fs.readdirSync(path.join(root, 'tools/showcase-build')).map((name) => `tools/showcase-build/${name}`),
    ...flowFiles(flowDirs.shopper).map((name) => `${flowDirs.shopper}/${name}`), ...flowFiles(flowDirs.owner).map((name) => `${flowDirs.owner}/${name}`)];
  for (const file of files) {
    const text = read(file).toLowerCase();
    for (const name of names) assert.ok(!text.includes(String(name).toLowerCase()), `${file} names a business`);
  }
});

test('Q-11 each flow set has the flows the showcase promises, and every flow counts toward Q-11', () => {
  const shopper = flowFiles(flowDirs.shopper);
  const owner = flowFiles(flowDirs.owner);
  assert.equal(shopper.length, 4);
  assert.equal(owner.length, 3);
  const expect = {
    shopper: [/tab-reels/, /openLink: \$\{APP_SCHEME\}:\/\/p\/\$\{PRODUCT_SLUG\}/, /mode-prepaid[\s\S]*Paid\. Thank you!/, /mode-cod[\s\S]*status-track|place-cod[\s\S]*status-track/],
    owner: [/sign-in-with-code/, /switcher-business-\$\{BUSINESS_1_ID\}[\s\S]*switcher-business-\$\{BUSINESS_2_ID\}/, /order-action-confirm[\s\S]*order-action-done/],
  };
  for (const [kind, names] of [['shopper', shopper], ['owner', owner]]) {
    const texts = names.map((name) => read(`${flowDirs[kind]}/${name}`));
    expect[kind].forEach((pattern, i) => assert.match(texts[i], pattern, `${kind} flow ${names[i]}`));
    for (const [i, text] of texts.entries()) {
      const flow = yaml.loadAll(text);
      assert.match(flow[0].name, /^Q-11: /, `${names[i]} starts with its requirement id`);
      assert.ok(Array.isArray(flow[1]) && flow[1].length > 2, `${names[i]} has steps`);
      assert.equal(flow[0].appId, '${APP_ID}');
    }
  }
});

test('Q-11 every value a flow reads is one the job\'s server hands it, and every file a flow runs exists', async () => {
  const { shopperFlowEnv } = await import('../../../tools/showcase-build/server.mjs');
  const { ownerFlowEnv } = await import('../../../tools/showcase-build/lib.mjs');
  const given = {
    shopper: new Set(Object.keys(shopperFlowEnv({ key: 'k', name: 'n', tenantId: 1, product: { name: 'p', slug: 's' } }, {}, { apiUrl: 'x', appHost: 'y' }))),
    owner: new Set([...Object.keys(ownerFlowEnv([{ tenantId: 1, name: 'a', order: { id: 1, number: 'n' } }, { tenantId: 2, name: 'b', order: { id: 2, number: 'm' } }], { apiUrl: 'x', whatsappUrl: 'y', appHost: 'z' })), 'APP_ID']),
  };
  for (const kind of ['shopper', 'owner']) {
    const base = path.dirname(flowDirs[kind]);
    const seen = new Set();
    const reads = [];
    // a value a flow passes down to a shared step in its own env block is that step's input, not the server's
    const passed = new Set();
    const collect = (node) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'env' && v && typeof v === 'object') Object.entries(v).forEach(([name, value]) => { if (String(value) !== '${' + name + '}') passed.add(name); });
          collect(v);
        }
      }
    };
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = read(file);
      yaml.loadAll(text).forEach(collect);
      for (const [, name] of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g)) {
        if (name.startsWith('output')) continue;
        reads.push([file, name]);
      }
      for (const [, ref] of text.matchAll(/^\s*file: (\S+)$/gm)) {
        const target = path.posix.join(path.posix.dirname(file), ref);
        assert.ok(fs.existsSync(path.join(root, target)), `${file} runs ${ref}, which is not there`);
        if (target.endsWith('.yaml')) visit(target);
      }
    };
    for (const name of flowFiles(flowDirs[kind])) visit(`${flowDirs[kind]}/${name}`);
    for (const [file, name] of reads) assert.ok(given[kind].has(name) || passed.has(name), `${file} reads ${name}, which neither the ${kind} server nor the flow passing it gives`);
    assert.ok(seen.size > flowFiles(flowDirs[kind]).length, `${kind} flows use the shared steps of ${base}`);
  }
});

test('Q-11 the flow runner installs the APK and runs only the showcase flows of the kind it is given', () => {
  const script = read('tools/showcase-build/run-flows.sh');
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /adb install -r "\$APK"/);
  assert.match(script, /shopper\) DIR=apps\/shopper\/\.maestro\/showcase/);
  assert.match(script, /owner\) DIR=apps\/owner\/\.maestro\/showcase/);
  assert.match(script, /maestro test .* "\$DIR"/);
  for (const job of ['shopper-flows', 'owner-flows']) {
    const emulator = stepsOf(job).find((step) => step.uses?.startsWith('reactivecircus/android-emulator-runner'));
    assert.match(emulator.with.script, /^bash tools\/showcase-build\/run-flows\.sh (shopper|owner) /);
    assert.ok(!emulator.with.script.includes('\n'), 'one line: the emulator action runs each line on its own');
  }
});
