// .github/workflows/apps.yml and the release config (PRD 10.1, "iOS ready from day one": I-01, P-02). GitHub Actions
// cannot run here: this reads the workflow as GitHub does, checks every shell step parses, runs the steps that can run
// off a runner (the job gate, the flow runner with stand-in adb and maestro), and reads eas.json and app.config.js.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml-lite.js';
import { checkApkBadging, checkXcode } from '../../../tools/build-check.mjs';
import { readAppConfig } from '../../../apps/owner/store/check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const workflow = parseYaml(read('.github/workflows/apps.yml'));
const jobs = workflow.jobs;
const runs = (job) => jobs[job].steps.filter((step) => step.run).map((step) => step.run).join('\n');
const BUILD_JOBS = ['app-tests', 'android', 'ios', 'android-e2e'];
const bash = (args, options = {}) => spawnSync('bash', args, { encoding: 'utf8', ...options });

test('I-01: every push, on main and every branch, and every pull request builds both apps; neither job can be skipped or pass on failure', () => {
  assert.ok(workflow.on.push.branches.includes('main') && workflow.on.push.branches.includes('**'));
  assert.ok('pull_request' in workflow.on);
  assert.equal(workflow.on.push.paths, undefined, 'no path filter: every push builds');
  assert.equal(workflow.on.push['paths-ignore'], undefined);
  for (const name of BUILD_JOBS) {
    assert.equal(jobs[name].if, undefined, `${name} runs on every push`);
    assert.notEqual(jobs[name]['continue-on-error'], true, name);
    for (const step of jobs[name].steps) assert.notEqual(step['continue-on-error'], true, `${name}: ${step.name}`);
  }
  assert.match(runs('android'), /gradlew :app:assembleRelease/);
  assert.match(runs('ios'), /xcodebuild[\s\S]*-sdk iphonesimulator[\s\S]*CODE_SIGNING_ALLOWED=NO/);
  for (const [job, artifact] of [['android', 'owner-android-apk'], ['ios', 'owner-ios-simulator-app']]) {
    const upload = jobs[job].steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
    assert.equal(upload.with.name, artifact);
    assert.equal(upload.with['if-no-files-found'], 'error', `${job}: a build that produced nothing fails`);
  }
  // A merge to main is never cancelled by the next one; a branch's older run is.
  assert.match(String(workflow.concurrency['cancel-in-progress']), /github\.ref != 'refs\/heads\/main'/);
  assert.equal(workflow.defaults.run.shell, 'bash', 'steps run with pipefail');
});

test('I-01: "Apps ready" needs every job and fails unless each one passed, skipped and cancelled included', () => {
  const ready = jobs.ready;
  assert.equal(ready.if, 'always()');
  assert.deepEqual([...ready.needs].sort(), [...BUILD_JOBS].sort());
  const step = ready.steps[0];
  assert.match(step.env.RESULTS, /toJSON\(needs\)/);
  const gate = (results) => spawnSync('bash', ['-c', step.run], { env: { ...process.env, RESULTS: JSON.stringify(results) }, encoding: 'utf8' });
  const all = (result) => Object.fromEntries(BUILD_JOBS.map((name) => [name, { result }]));
  assert.equal(gate(all('success')).status, 0);
  for (const bad of ['failure', 'cancelled', 'skipped']) {
    const run = gate({ ...all('success'), ios: { result: bad } });
    assert.equal(run.status, 1, bad);
    assert.match(run.stdout, new RegExp(`ios: ${bad}`));
  }
});

test('P-02: the APK\'s target SDK and the Xcode and iOS SDK versions are checked in the jobs that build them', () => {
  assert.match(runs('android'), /aapt2"? dump badging[\s\S]*build-check\.mjs apk --package "\$APP_ID"/i);
  assert.match(runs('ios'), /Xcode_26/);
  assert.match(runs('ios'), /build-check\.mjs xcode/);
  assert.match(runs('ios'), /DTSDKName[\s\S]*DTXcode[\s\S]*-ge 2600/);
  assert.match(runs('ios'), /PrivacyInfo\.xcprivacy[\s\S]*NSPrivacyTracking/);
  assert.match(jobs.ios['runs-on'], /^macos-(2[6-9]|[3-9]\d)$/);
  const badging = (target) => `package: name='com.bhava.business' versionCode='1'\nsdkVersion:'24'\ntargetSdkVersion:'${target}'\n`;
  assert.equal(checkApkBadging(badging(35)).ok, false);
  assert.equal(checkApkBadging(badging(36)).ok, true);
  assert.equal(checkXcode('Xcode 26.0\nBuild version 17A1\n\t-sdk iphonesimulator26.0\n').ok, true);
  assert.equal(checkXcode('Xcode 16.4\nBuild version 16F6\n\t-sdk iphonesimulator18.5\n').ok, false);
  const props = readAppConfig(ROOT).plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties')[1];
  assert.ok(props.android.targetSdkVersion >= 36);
});

test('no keystore, Apple key or Firebase file is in the repository or a log: the job\'s key is masked, silent and deleted', () => {
  const text = read('.github/workflows/apps.yml');
  assert.doesNotMatch(text, /\$\{\{\s*secrets\./, 'the builds need no secret');
  assert.doesNotMatch(text, /set -x|EXPO_TOKEN|eas build/i);
  assert.match(runs('app-tests'), /npm run secret-scan/);
  for (const job of ['android', 'android-e2e']) {
    const steps = jobs[job].steps;
    const make = steps.findIndex((step) => /keytool -genkeypair/.test(step.run ?? ''));
    assert.ok(make >= 0, job);
    const lines = steps[make].run.split('\n');
    assert.ok(lines.findIndex((l) => l.includes('::add-mask::$KEY_PASS')) < lines.findIndex((l) => l.includes('keytool')), `${job}: masked before use`);
    assert.match(steps[make].run, /keytool[\s\S]*> \/dev\/null/, `${job}: keytool prints nothing`);
    assert.match(steps[make].run, /\$RUNNER_TEMP\//, `${job}: the key lives outside the checkout`);
    const drop = steps.find((step) => /rm -f "\$RUNNER_TEMP\/\w+\.keystore"/.test(step.run ?? ''));
    assert.equal(drop?.if, 'always()', `${job}: the key is deleted even when the build fails`);
    assert.ok(steps.indexOf(drop) > make);
  }
  assert.match(runs('android'), /unzip -Z1[\s\S]*google-services[\s\S]*p8\|p12/);
  // The repository's own scan refuses the files by name.
  const scan = read('tools/secret-scan.mjs');
  for (const name of ['keystore', 'p8', 'p12', 'google-services', 'GoogleService-Info']) assert.match(scan, new RegExp(name.replace('.', '\\.')));
  assert.match(read('apps/owner/.gitignore'), /android\//);
});

test('every shell step parses as bash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-steps-'));
  try {
    for (const [name, job] of Object.entries(jobs)) {
      for (const [index, step] of job.steps.entries()) {
        const script = [step.run, step.with?.script].filter(Boolean).join('\n');
        if (!script) continue;
        const file = path.join(dir, `${name}-${index}.sh`);
        fs.writeFileSync(file, script.replace(/\$\{\{[^}]*\}\}/g, 'X'));
        const run = bash(['-n', file]);
        assert.equal(run.status, 0, `${name}: ${step.name ?? index}: ${run.stderr}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the emulator job runs the flows against its own server, with a pinned Maestro, and the runner passes every value through', () => {
  const steps = runs('android-e2e');
  assert.match(steps, /node apps\/owner\/\.maestro\/support\/server\.mjs --out "\$RUNNER_TEMP\/flows\.env"/);
  assert.match(steps, /kill "\$\(cat "\$RUNNER_TEMP\/server\.pid"\)"/);
  assert.match(jobs['android-e2e'].env.MAESTRO_VERSION, /^\d+\.\d+\.\d+$/);
  const emulator = jobs['android-e2e'].steps.find((step) => step.uses?.startsWith('reactivecircus/android-emulator-runner'));
  assert.equal(emulator.with.script.split('\n').length, 1, 'the emulator runner runs each line alone: one command');
  assert.match(emulator.with.script, /^bash apps\/owner\/\.maestro\/support\/run-flows\.sh /);
  assert.match(jobs['android-e2e'].steps.find((s) => s.name?.startsWith('Build the APK')).env.API_BASE_URL, /^http:\/\/10\.0\.2\.2:/);

  // The runner, with stand-ins for adb and maestro that write down how they were called.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-runner-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const tool of ['adb', 'maestro']) {
      fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${dir.replace(/\\/g, '/')}/${tool}.args"\necho "@@end" >>"${dir.replace(/\\/g, '/')}/${tool}.args"\n`, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(dir, 'flows.env'), 'API_URL=http://127.0.0.1:3000\nBUSINESS_A_NAME=Indigo Loom\nORDER_A_ID=1\n');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, APP_ID: 'com.bhava.business' };
    const run = bash([path.join(ROOT, 'apps/owner/.maestro/support/run-flows.sh'), path.join(dir, 'flows.env'), 'app.apk', 'report.xml'], { cwd: ROOT, env });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'adb.args'), 'utf8').trim().split(/\r?\n/), ['install', '-r', 'app.apk', '@@end']);
    const calls = fs.readFileSync(path.join(dir, 'maestro.args'), 'utf8').split(/@@end\r?\n?/).filter((call) => call.trim()).map((call) => call.split(/\r?\n/).filter(Boolean));
    assert.deepEqual(calls[1], ['test', '-e', 'APP_ID=com.bhava.business', '-e', 'API_URL=http://127.0.0.1:3000', '-e', 'BUSINESS_A_NAME=Indigo Loom', '-e', 'ORDER_A_ID=1', '--format', 'junit', '--output', 'report.xml', 'apps/owner/.maestro']);
    const missing = bash([path.join(ROOT, 'apps/owner/.maestro/support/run-flows.sh'), path.join(dir, 'flows.env'), 'app.apk', 'report.xml'], { cwd: ROOT, env: { ...env, APP_ID: '' } });
    assert.notEqual(missing.status, 0, 'no APP_ID, no run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('eas.json is ready for later with nothing account-specific in it, and the app config needs no account to build', () => {
  const eas = JSON.parse(read('apps/owner/eas.json'));
  const text = JSON.stringify(eas);
  assert.doesNotMatch(text, /projectId|"owner"|appleId|ascAppId|appleTeamId|serviceAccountKeyPath|keystore|credentialsSource|p12|p8|\b[0-9a-f]{8}-[0-9a-f]{4}-/i);
  assert.deepEqual(Object.keys(eas.build).sort(), ['development', 'preview', 'production']);
  assert.equal(eas.build.production.android.buildType, 'app-bundle');
  assert.equal(eas.build.preview.ios.simulator, true);
  for (const [name, profile] of Object.entries(eas.build)) assert.equal(profile.env.APP_ENV, name);
  assert.deepEqual(eas.submit.production, {});

  const config = readAppConfig(ROOT);
  assert.equal(config.owner, undefined);
  assert.equal(config.extra?.eas, undefined, 'no EAS project id');
  assert.deepEqual(config.updates, { enabled: false }, 'no update server unless one is set');
  assert.equal(config.android.googleServicesFile, undefined);
  assert.equal(config.extra.push.android || config.extra.push.ios, false, 'push is off with no keys, and the app still builds');
  assert.ok(!config.plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-notifications'));
  assert.throws(() => readAppConfig(ROOT, { APP_ENV: 'production' }), /https/);
  const production = readAppConfig(ROOT, { APP_ENV: 'production', API_BASE_URL: 'https://app.example.com' });
  assert.equal(production.extra.apiBaseUrl, 'https://app.example.com');
  assert.equal(production.ios.infoPlist.NSAppTransportSecurity, undefined, 'a production build allows no plain http');
  // The config reads with Expo's plugin code loaded only when prebuild runs it.
  assert.doesNotMatch(read('apps/owner/app.config.js'), /^const .*require\('expo\/config-plugins'\)/m);
});

test('the YAML reader these tests use reads what the workflow and the flows are written in, and refuses what it cannot', async () => {
  const { parseYaml, parseYamlDocs } = await import('./yaml-lite.js');
  const text = [
    'on:',
    '  push:',
    "    branches: [main, '**'] # every branch",
    'jobs:',
    '  a:',
    '    with: { node-version: 22, cache: npm }',
    '    steps:',
    '      - uses: x@v4',
    '      - name: "Two: lines"',
    '        run: |',
    '          echo "# not a comment"',
    '',
    '          test $A -ge 2',
    "      - name: 'It''s quoted'",
  ].join('\n');
  assert.deepEqual(parseYaml(text), {
    on: { push: { branches: ['main', '**'] } },
    jobs: { a: { with: { 'node-version': 22, cache: 'npm' }, steps: [{ uses: 'x@v4' }, { name: 'Two: lines', run: 'echo "# not a comment"\n\ntest $A -ge 2\n' }, { name: "It's quoted" }] } },
  });
  assert.deepEqual(parseYamlDocs('appId: ${APP_ID}\n---\n- hideKeyboard\n- tapOn:\n    id: x-${N}\n- runFlow:\n    when:\n      visible:\n        id: y\n    commands:\n      - back\n'), [
    { appId: '${APP_ID}' },
    ['hideKeyboard', { tapOn: { id: 'x-${N}' } }, { runFlow: { when: { visible: { id: 'y' } }, commands: ['back'] } }],
  ]);
  assert.throws(() => parseYaml('a: 1\n   b: 2\n'), /indentation|not read/);
  assert.throws(() => parseYaml("a: 'open\n"), /Unclosed quote/);
});
