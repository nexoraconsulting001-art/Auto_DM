// .github/workflows/brand-apps.yml (PRD 10.1, P-01, P-31, P-36, P-55; "iOS ready from day one", I-03). GitHub Actions cannot run
// here: this reads the workflow as GitHub does, checks every shell step parses, runs the steps that can run off a runner
// (the job gate, the flow runner with stand-in adb and maestro), and reads the build settings. What only a runner can prove
// is listed in the report of this track, not pretended here.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../../p5/app-release/yaml-lite.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const workflow = parseYaml(read('.github/workflows/brand-apps.yml'));
const jobs = workflow.jobs;
const runs = (job) => jobs[job].steps.filter((step) => step.run).map((step) => step.run).join('\n');
const stepNamed = (job, pattern) => jobs[job].steps.find((step) => pattern.test(step.name ?? ''));
const bash = (args, options = {}) => spawnSync('bash', args, { encoding: 'utf8', ...options });
const BUILD_JOBS = ['app-tests', 'android', 'ios', 'android-e2e'];

test('P-01: every push and pull request builds an APK and an iOS simulator app for every fixture brand, and none of it can be skipped or pass on failure', () => {
  assert.ok(workflow.on.push.branches.includes('main') && workflow.on.push.branches.includes('**'));
  assert.ok('pull_request' in workflow.on);
  assert.equal(workflow.on.push.paths, undefined, 'no path filter: every push builds');
  for (const name of BUILD_JOBS) {
    assert.equal(jobs[name].if, undefined, `${name} runs on every push`);
    assert.notEqual(jobs[name]['continue-on-error'], true, name);
    for (const step of jobs[name].steps) assert.notEqual(step['continue-on-error'], true, `${name}: ${step.name}`);
  }
  for (const name of ['android', 'ios', 'android-e2e']) {
    assert.match(String(jobs[name].strategy.matrix.brand), /fromJSON\(needs\.brands\.outputs\.brands\)/, `${name} builds every brand found in the fixtures`);
    assert.equal(jobs[name].strategy['fail-fast'], false, `${name}: one brand failing does not hide another`);
  }
  assert.match(runs('android'), /--platform android --driver local/);
  assert.match(runs('ios'), /--platform ios --driver local --profile simulator/);
  assert.match(runs('brands'), /-ge 2/, 'at least two brands, so "different name, icon, package and colours" is something');
  for (const [job, prefix] of [['android', 'shopper-android-apk-'], ['ios', 'shopper-ios-simulator-app-']]) {
    const upload = jobs[job].steps.find((step) => step.uses?.startsWith('actions/upload-artifact') && String(step.with.name).startsWith(prefix));
    assert.ok(upload, `${job} uploads its build`);
    assert.equal(upload.with['if-no-files-found'], 'error', `${job}: a build that produced nothing fails`);
  }
  // The gate: one job that fails unless every job passed, including when one was skipped or cancelled.
  assert.equal(jobs.ready.if, 'always()');
  assert.deepEqual([...jobs.ready.needs].sort(), ['android', 'android-e2e', 'app-tests', 'brands', 'ios']);
});

test('the brand differences are checked in the built APK: package, name, signature, and no key or payment SDK inside', () => {
  const text = runs('android');
  assert.match(text, /build-check\.mjs apk[\s\S]*--package[\s\S]*--label/);
  assert.match(text, /"\$APKSIGNER" verify --print-certs/);
  assert.match(text, /google-services\\\.json[\s\S]*keystore/);
});

test('P-01, P-31: the built APK and the simulator app are scanned for the platform name and every other brand\'s name', () => {
  for (const job of ['android', 'ios']) {
    const text = runs(job);
    assert.match(text, /scan-binary\.mjs binary "\$(APK|APP)" --brand "\$FIXTURES\/\$BRAND\/brand\.json" "\$\{OTHERS\[@\]\}"/, `${job} scans the build`);
    assert.match(text, /for FILE in "\$FIXTURES"\/\*\/brand\.json/, `${job}: every other fixture brand is looked for`);
  }
  const step = stepNamed('android', /manifest, strings and bundled files/);
  assert.ok(step, 'the android scan has its own step');
  const index = jobs.android.steps.indexOf(step);
  assert.ok(index > jobs.android.steps.findIndex((s) => /build the brand/i.test(s.name ?? '')), 'it runs after the build');
});

test('P-36: the build logs are kept and checked for a key, keystore content or the password; the password is masked and the key deleted', () => {
  for (const job of ['android', 'android-e2e']) {
    const text = runs(job);
    assert.match(text, /2>&1 \| tee "\$RUNNER_TEMP\/build\.log"/, `${job} keeps the build log`);
    assert.match(text, /scan-binary\.mjs log "\$RUNNER_TEMP\/build\.log" --secret ANDROID_KEYSTORE_PASSWORD/);
    assert.match(text, /::add-mask::\$KEY_PASS/, `${job} masks the password`);
    assert.ok(jobs[job].steps.some((s) => s.if === 'always()' && /rm -f/.test(s.run ?? '') && /keystore/.test(s.run)), `${job} deletes the key whatever happened`);
    // The key is made in the job and nothing prints it.
    assert.doesNotMatch(text, /echo[^\n]*\$KEY_PASS(?!")/, 'the password is echoed only into the environment file');
    assert.doesNotMatch(text, /cat[^\n]*keystore/);
    assert.doesNotMatch(text, /base64[^\n]*keystore/);
  }
  assert.match(runs('ios'), /scan-binary\.mjs log "\$RUNNER_TEMP\/build\.log"/);
  assert.equal(workflow.permissions.contents, 'read');
  assert.doesNotMatch(read('.github/workflows/brand-apps.yml'), /secrets\./, 'the workflow uses no secret of the repository: no account');
});

test('the flows run on an emulator against the job\'s own server, and the listing shots are taken from the same build', () => {
  const emulator = jobs['android-e2e'].steps.find((step) => step.uses?.startsWith('reactivecircus/android-emulator-runner'));
  assert.ok(emulator);
  const lines = emulator.with.script.trim().split('\n');
  assert.match(lines[0], /^bash apps\/shopper\/\.maestro\/support\/run-flows\.sh /);
  assert.match(lines[1], /^bash tools\/listing-shots\/capture-android\.sh "\$RUNNER_TEMP\/flows\.env" "\$APK" "\$RUNNER_TEMP\/shots"$/);
  assert.match(runs('android-e2e'), /server\.mjs --brand "\$FIXTURES\/\$BRAND\/brand\.json" --out "\$RUNNER_TEMP\/flows\.env"/);
  assert.match(runs('android-e2e'), /listing-shots\/index\.mjs fit --platform android --captures "\$RUNNER_TEMP\/shots" --build "\$APK"/);
  assert.match(String(jobs['android-e2e'].steps.find((s) => /Build the brand's APK for the emulator/.test(s.name ?? '')).env.API_BASE_URL), /^http:\/\/10\.0\.2\.2:/);
  assert.equal(jobs['android-e2e'].steps.find((s) => /Build the brand's APK/.test(s.name ?? '')).env.ANDROID_ARCHITECTURES, 'x86_64');
  // The pictures are kept for the listing.
  const upload = jobs['android-e2e'].steps.find((s) => s.uses?.startsWith('actions/upload-artifact'));
  assert.match(String(upload.with.path), /listing-shots/);
  // iOS: the simulator build talks to the same kind of server, and its shots are fitted to the App Store sizes.
  assert.match(String(stepNamed('ios', /Compile the brand/).env.API_BASE_URL), /^http:\/\/localhost:/);
  assert.match(runs('ios'), /capture-ios\.sh "\$RUNNER_TEMP\/flows\.env" "\$RUNNER_TEMP\/shopper-ios-simulator\.zip"/);
  assert.match(runs('ios'), /listing-shots\/index\.mjs fit --platform ios/);
  assert.match(runs('ios'), /pick-simulator\.mjs/);
  assert.match(String(jobs.ios.steps.find((s) => s.name?.startsWith('Start the server')).env.APP_HOST), /^localhost$/);
  assert.equal(jobs['app-tests'].steps.some((s) => /test\/p6\/brand-ci/.test(s.run ?? '')), true, 'these tests run in the app-tests job');
});

test('every shell step parses', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      if (!step.run) continue;
      const parsed = bash(['-n'], { input: step.run });
      assert.equal(parsed.status, 0, `${name}: ${step.name}: ${parsed.stderr}`);
    }
  }
  const script = emulatorScript();
  assert.equal(bash(['-n'], { input: script }).status, 0);
});

function emulatorScript() {
  return jobs['android-e2e'].steps.find((step) => step.uses?.startsWith('reactivecircus/android-emulator-runner')).with.script;
}

test('the flow runner passes every value the server wrote to Maestro, and runs the flows folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-ci-run-'));
  try {
    const tool = (name) => fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir.replaceAll('\\', '/')}/${name}.args"\n`, { mode: 0o755 });
    tool('adb');
    tool('maestro');
    fs.writeFileSync(path.join(dir, 'flows.env'), 'APP_ID=example.zarvelo.shop\nPRODUCT_SLUG=flow-test-mug\nSIM_WHATSAPP_URL=http://127.0.0.1:9102\n');
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
    const run = bash([path.join(ROOT, 'apps/shopper/.maestro/support/run-flows.sh'), path.join(dir, 'flows.env'), 'app.apk', 'report.xml'], { cwd: ROOT, env });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'adb.args'), 'utf8').trim(), 'install -r app.apk');
    const calls = fs.readFileSync(path.join(dir, 'maestro.args'), 'utf8').trim().split('\n');
    assert.equal(calls[1], 'test -e APP_ID=example.zarvelo.shop -e PRODUCT_SLUG=flow-test-mug -e SIM_WHATSAPP_URL=http://127.0.0.1:9102 --format junit --output report.xml apps/shopper/.maestro');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the job gate fails unless every job succeeded', () => {
  const script = jobs.ready.steps.find((step) => step.run).run;
  const gate = (needs) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, RESULTS: JSON.stringify(needs) } });
  const ok = { brands: { result: 'success' }, android: { result: 'success' }, ios: { result: 'success' } };
  assert.equal(gate(ok).status, 0);
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const run = gate({ ...ok, ios: { result } });
    assert.equal(run.status, 1, result);
    assert.match(run.stdout, new RegExp(`ios: ${result}`));
  }
});

test('the brand profile the workflow builds with exists in eas.json, with no project and no account', () => {
  const eas = JSON.parse(read('apps/shopper/eas.json'));
  for (const profile of ['development', 'preview', 'simulator', 'production']) assert.ok(eas.build[profile], profile);
  assert.equal(eas.build.simulator.ios.simulator, true);
  assert.equal(eas.build.production.ios.simulator, false);
  assert.ok(!/projectId|"owner"|appleId|ascAppId|serviceAccountKeyPath/.test(JSON.stringify(eas)));
});
