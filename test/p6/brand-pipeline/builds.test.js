import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { checkAsset, namesPlatform } from '../../../src/contracts/apps.js';
import { ApiError } from '../../../src/contracts/api/index.js';
import { setLogSink } from '../../../src/platform/log.js';
import { appBuildsFor } from '../../../src/modules/app-builds/index.js';
import { measureImage } from '../../../src/modules/app-builds/images.js';
import { runForBusiness } from '../../../src/modules/app-builds/cli.js';
import { EXPO_TOKEN, brand, key, plainBusiness, png, startWorld } from './support.js';

// Per-brand builds (PRD 10.8): a request checked on the server against the plan and the details, one build per request key and
// platform with the brand's own build numbers and the shared app version, a run through the build tool and the eas driver
// against tools/sim/eas, the poll that follows it, and the hand-over to the brand's own store accounts. P-32, P-33, P-34.

let w;
const lines = [];
before(async () => {
  w = await startWorld();
  setLogSink((line) => lines.push(line));
});
after(async () => {
  setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));
  await w?.close();
});

const request = (body) => w.api('POST', '/app-publishing/builds', body);
const easBuilds = async () => (await w.eas.get('/builds')).builds;

test('P-32: a complete kit builds both platforms on the build service, follows them and hands each to the store; numbers are the brand\'s own', async () => {
  const b = await brand(w, { platforms: ['android', 'ios'], name: 'Mehta Mart' });
  const sent = [];
  const service = w.builds({ submit: async (id, options) => { sent.push({ id, options }); return {}; } });
  const before = (await easBuilds()).length;
  const requestKey = key();
  const builds = await b.run(() => service.request({ platforms: ['android', 'ios'], requestKey, actor: 'user:1' }));
  assert.deepEqual(builds.map((x) => [x.platform, x.status, x.buildNumber]), [['android', 'queued', 1], ['ios', 'queued', 1]]);
  assert.equal(builds[0].appVersion, builds[1].appVersion, 'One app version for every platform');
  // The same request again is the same builds, even at the same moment.
  const twins = await Promise.all([1, 2, 3].map(() => b.run(() => service.request({ platforms: ['android', 'ios'], requestKey, actor: 'user:1' }))));
  for (const twin of twins) assert.deepEqual(twin.map((x) => x.id), builds.map((x) => x.id));
  assert.equal((await b.builds()).length, 2);

  for (const x of builds) assert.equal((await b.run(() => service.run(x.id))).status, 'building');
  assert.equal((await easBuilds()).length, before + 2, 'The build service got two builds');
  const calls = (await w.eas.calls({ method: 'POST', path: '/v1/builds' })).map((c) => c.body).filter((c) => c.channel === `t${b.tenant.id}`);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.profile, 'production');
    assert.equal(c.brandFile.tenantId, b.tenant.id);
    assert.equal(c.brandFile.name, 'Mehta Mart');
    assert.equal(c.buildNumber, 1);
    const text = JSON.stringify(c);
    assert.ok(!text.includes(EXPO_TOKEN) && !/PRIVATE KEY|keystore|\.p8|\.p12|password/i.test(text), 'A secret went to the build service');
    assert.ok(!namesPlatform(text), 'The build request names the platform');
  }
  // Running the job again does nothing: the build has moved on.
  assert.equal((await b.run(() => service.run(builds[0].id))).skipped, true);
  assert.equal((await easBuilds()).length, before + 2);

  const done = await w.drive(service, async () => {
    const rows = await b.builds();
    return rows.every((r) => r.status === 'submitted') ? rows : null;
  });
  assert.ok(done, `The builds did not reach submitted: ${JSON.stringify((await b.builds()).map((r) => [r.platform, r.status, r.failed_message, r.submit_error]))}`);
  assert.deepEqual(sent.map((s) => s.id).sort(), builds.map((x) => x.id).sort(), 'Each built build was handed to the store once');
  for (const r of done) {
    assert.ok(r.submitted_at && r.finished_at && r.started_at);
    assert.ok(r.provider_build_id && r.config_hash.length === 64);
    assert.ok(r.artifact_key.startsWith(`t/${b.tenant.id}/app-builds/${r.id}/`), 'The artifact is kept in the business\'s private storage');
    assert.ok(await w.ctx.platform.storage.get(r.artifact_key));
  }
  // The first submitted build locks the ids the stores know the app by.
  const row = await b.row();
  assert.ok(row.android_locked_at && row.ios_locked_at);
  // The next request takes the next numbers, on the same app version.
  const next = await b.run(() => service.request({ platforms: ['android'], requestKey: key(), actor: 'user:1' }));
  assert.equal(next[0].buildNumber, 2);
  assert.equal(next[0].appVersion, builds[0].appVersion);
  // Nothing logged a name, the token or an address.
  const logged = lines.join('\n');
  assert.ok(!logged.includes(EXPO_TOKEN) && !logged.includes('Mehta Mart') && !logged.includes(w.eas.url), 'The log holds a token, a name or an address');
});

test('the owner asks over the API: 202, only the owner, only the plan\'s platforms, the request checked first and nothing written when refused', async () => {
  let res = await request({ platforms: ['android', 'ios'], requestKey: key() });
  assert.equal(res.status, 202, res.text);
  assert.deepEqual(res.body.builds.map((x) => x.platform), ['android', 'ios']);
  const list = await w.api('GET', '/app-publishing/builds?limit=10');
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 2);
  // A second request while those run is refused for that platform.
  res = await request({ platforms: ['android'], requestKey: key() });
  assert.equal(res.status, 409, res.text);
  // Bad input.
  for (const body of [{ platforms: [], requestKey: key() }, { platforms: ['android'], requestKey: 'short' }, { platforms: ['windows'], requestKey: key() }, { platforms: ['android'], requestKey: key(), brandFile: {} }]) {
    assert.equal((await request(body)).status, 400, JSON.stringify(body));
  }
  // An Android-only plan has no iOS, and a plan with no app has neither: refused on the server, nothing written.
  const service = w.builds();
  const android = await brand(w, { platforms: ['android'] });
  await w.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES ($1, 'app.ios', false) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = false`, [android.tenant.id]);
  await assert.rejects(android.run(() => service.request({ platforms: ['ios'], requestKey: key() })), (err) => err instanceof ApiError && err.status === 403);
  await assert.rejects(android.run(() => service.request({ platforms: ['android', 'ios'], requestKey: key() })), (err) => err.status === 403);
  assert.equal((await android.builds()).length, 0);
  const plain = await plainBusiness(w);
  await assert.rejects(plain.run(() => service.request({ platforms: ['android'], requestKey: key() })), (err) => err.status === 403);
  // Our team's route takes the same rules.
  assert.equal((await w.console('POST', `/tenants/${plain.tenant.id}/app-builds`, { platforms: ['android'], requestKey: key() })).status, 403);
  assert.equal((await w.console('POST', `/tenants/${android.tenant.id}/app-builds`, { platforms: ['ios'], requestKey: key() })).status, 403);
  const ok = await w.console('POST', `/tenants/${android.tenant.id}/app-builds`, { platforms: ['android'], requestKey: key() });
  assert.equal(ok.status, 202, ok.text);
  assert.equal(ok.body.builds[0].platform, 'android');
});

test('P-33: a missing privacy URL stops the request before anything is built or written, naming the field', async () => {
  const b = await brand(w, { platforms: ['android', 'ios'] });
  await b.set({ privacy_url: '' });
  const service = w.builds();
  const batchesBefore = (await w.sql('SELECT count(*)::int AS n FROM app_build_batches'))[0].n;
  const before = (await easBuilds()).length;
  await assert.rejects(b.run(() => service.request({ platforms: ['android', 'ios'], requestKey: key() })), (err) => {
    assert.equal(err.status, 409);
    assert.ok(err.fields.privacyUrl, JSON.stringify(err.fields));
    assert.match(err.message, /privacy/i);
    return true;
  });
  assert.equal((await b.builds()).length, 0);
  assert.equal((await w.sql('SELECT count(*)::int AS n FROM app_build_batches'))[0].n, batchesBefore);
  assert.equal((await easBuilds()).length, before);
  assert.equal((await b.row()).android_next_build, 1, 'A refused request took a build number');
});

test('P-34: an icon that fails the spec after the request stops the run at validate, names the field with the spec message, and nothing is built', async () => {
  const b = await brand(w, { platforms: ['android'] });
  const service = w.builds();
  const [build] = await b.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  const tiny = await b.run(async () => w.ctx.repos.media.save(await png(600, 600), 'image/png'));
  await b.set({ icon_media_id: tiny });
  const before = (await easBuilds()).length;
  const result = await b.run(() => service.run(build.id));
  assert.equal(result.status, 'failed');
  const [row] = await b.builds();
  assert.equal(row.status, 'failed');
  assert.ok(['validate', 'assets'].includes(row.failed_step), row.failed_step);
  assert.equal(row.failed_field, 'iconMediaId');
  assert.match(row.failed_message, /1024 x 1024/);
  assert.equal((await easBuilds()).length, before, 'A build reached the build service');
  const [told] = await w.sql(`SELECT kind FROM notification_events WHERE tenant_id = $1 AND kind = 'app.build_failed'`, [b.tenant.id]);
  assert.ok(told, 'The owner was not told');
});

test('P-55: the generated images pass the stores\' spec: the store icon has no transparency, even from a transparent source', async () => {
  const b = await brand(w, { platforms: ['android', 'ios'], icon: false });
  const transparent = await b.run(async () => w.ctx.repos.media.save(await png(1024, 1024, { alpha: true }), 'image/png'));
  await b.set({ icon_media_id: transparent });
  const seen = [];
  const fake = { name: 'local', build: async ({ platform, brand: file, brandFile, brandDir }) => {
    seen.push({ platform, file, folder: brandDir, json: fs.readFileSync(brandFile, 'utf8'), images: Object.fromEntries(await Promise.all(Object.entries(file.assets).map(async ([k, name]) => [k, await measureImage(fs.readFileSync(path.join(brandDir, name)))]))) });
    return { platform, status: 'built', artifact: null, detail: 'fake' };
  } };
  const service = w.builds({ drivers: { local: fake, eas: fake } });
  const builds = await b.run(() => service.request({ platforms: ['android', 'ios'], requestKey: key() }));
  await w.sql(`UPDATE app_builds SET driver = 'local' WHERE tenant_id = $1`, [b.tenant.id]);
  for (const x of builds) await b.run(() => service.run(x.id));
  assert.equal(seen.length, 2);
  const specs = { icon: 'icon_ios', adaptiveForeground: 'adaptive_foreground', adaptiveBackground: 'adaptive_background', notificationIcon: 'notification_icon', splash: 'splash' };
  for (const s of seen) {
    for (const [k, spec] of Object.entries(specs)) assert.deepEqual(checkAsset(spec, s.images[k]), [], `${s.platform} ${k}: ${JSON.stringify(s.images[k])}`);
    assert.equal(s.images.icon.hasAlpha, false);
    assert.ok(!fs.existsSync(s.folder), 'The brand folder was left behind');
  }
  for (const r of await b.builds()) assert.equal(r.status, 'built', r.failed_message);
});

test('the build service failing, hanging or answering junk: a failed build says why, a poll moves nothing, the other platform carries on', async () => {
  const b = await brand(w, { platforms: ['android', 'ios'] });
  const service = w.builds();
  await w.eas.post('/builds/behaviour', { kind: 'fail', platform: 'ios', message: 'Provisioning profile is missing.' });
  const builds = await b.run(() => service.request({ platforms: ['android', 'ios'], requestKey: key() }));
  for (const x of builds) await b.run(() => service.run(x.id));
  // Junk and silence while polling: nothing moves.
  for (const fault of [{ kind: 'timeout' }, { kind: 'malformed', mode: 'html' }, { kind: 'server_error', status: 502 }, { kind: 'drop' }]) {
    await w.eas.post('/faults', { ...fault, times: 'forever', match: { method: 'GET', path: '/v1/builds/*' } });
    await w.eas.post('/clock', { advanceMs: 120_000 });
    await service.poll();
    await w.eas.delete('/faults');
    for (const r of await b.builds()) assert.equal(r.status, 'building', `A ${fault.kind} moved a build to ${r.status}`);
  }
  await service.poll();
  const rows = Object.fromEntries((await b.builds()).map((r) => [r.platform, r]));
  assert.equal(rows.ios.status, 'failed');
  assert.equal(rows.ios.failed_step, 'build');
  assert.match(rows.ios.failed_message, /Provisioning/);
  assert.equal(rows.android.status, 'submitted');
  // Starting a build when the service is down fails it with a plain sentence, no address, no token.
  await w.eas.post('/faults', { kind: 'server_error', status: 500, times: 'forever', match: { method: 'POST', path: '/v1/builds' } });
  const [down] = await b.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  await b.run(() => service.run(down.id));
  await w.eas.delete('/faults');
  const [failed] = (await b.builds()).filter((r) => r.id === down.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.failed_message, /build service/);
  assert.ok(!failed.failed_message.includes(w.eas.url) && !failed.failed_message.includes(EXPO_TOKEN));
});

test('a store refusal leaves the build built with the reason; the next poll does not resend it on its own', async () => {
  const b = await brand(w, { platforms: ['android'] });
  let tries = 0;
  const service = w.builds({ submit: async () => { tries += 1; throw new ApiError('conflict', 'The pre-submit check failed: account deletion is missing.'); } });
  const [x] = await b.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  await b.run(() => service.run(x.id));
  await w.drive(service, async () => ((await b.builds())[0].status === 'built' ? true : null));
  const [row] = await b.builds();
  assert.equal(row.status, 'built');
  assert.match(row.submit_error, /account deletion/);
  await service.poll();
  assert.equal(tries, 1);
  assert.equal((await b.row()).android_locked_at, null, 'An unsent build locked the ids');
});

test('seller text is only data: a name built of shell, path and JSON tricks reaches no command, no path and no other key of the brand file', async () => {
  const trick = '"; rm -rf / #$(id)`x`';
  const b = await brand(w, { platforms: ['android'], name: 'Safe Name' });
  await b.set({ app_name: trick.slice(0, 30), short_name: '../../etc' });
  const commands = [];
  const service = w.builds({ anyHost: true, exec: async (command, args, options) => { commands.push({ command, args, cwd: options.cwd, env: options.env }); } });
  const [x] = await b.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  await w.sql(`UPDATE app_builds SET driver = 'local', profile = 'preview' WHERE id = $1`, [x.id]);
  await b.run(() => service.run(x.id));
  assert.ok(commands.length >= 2, 'The local driver ran no command');
  for (const c of commands) {
    const text = [c.command, ...c.args, c.cwd].join(' ');
    assert.ok(!text.includes('rm -rf') && !text.includes('../../etc') && !text.includes('$(id)'), `Seller text reached a command: ${text}`);
    assert.ok(path.basename(c.env.BRAND_FILE) === 'brand.json' && c.env.BRAND_FILE.includes(`t${b.tenant.id}`));
    for (const secret of ['DATABASE_URL', 'DATA_KEY', 'EXPO_TOKEN', 'SESSION_SECRET']) assert.equal(c.env[secret], undefined, `${secret} reached a build command`);
  }
  // No APK came out of the fake runner: the build fails, saying so, and the folder is gone.
  const [row] = await b.builds();
  assert.equal(row.status, 'failed');
  assert.ok(!fs.existsSync(path.dirname(commands[0].env.BRAND_FILE)));
});

test('the command line builds one business from the database and prints ids and statuses only', async () => {
  const b = await brand(w, { platforms: ['android'], name: 'Printed Nowhere' });
  const printed = [];
  const fake = { name: 'local', build: async ({ platform }) => ({ platform, status: 'built', artifact: null, detail: 'fake' }) };
  const result = await b.run(() => runForBusiness({ ...w.ctx, config: { ...w.ctx.config, appBuildDriver: 'local' } }, { platforms: ['android'], everyMs: 5, timeoutMs: 5_000 }, (line) => printed.push(line), { drivers: { local: fake } }));
  assert.equal(result.ok, true, printed.join('\n'));
  assert.deepEqual(result.builds.map((x) => [x.platform, x.status, x.buildNumber]), [['android', 'built', 1]]);
  assert.ok(printed.some((l) => /android build 1: built/.test(l)), printed.join('\n'));
  assert.ok(!printed.join('\n').includes('Printed Nowhere'));
  // A business whose details would not build is stopped before anything, naming the field.
  await b.set({ privacy_url: '' });
  const stopped = await b.run(() => runForBusiness(w.ctx, { platforms: ['android'] }, (line) => printed.push(line), { drivers: { local: fake } }));
  assert.equal(stopped.ok, false);
  assert.ok(stopped.fields.privacyUrl);
  assert.ok(printed.some((l) => /privacyUrl/.test(l)));
});

test('builds are one business\'s own: another business cannot read, run or move them', async () => {
  const a = await brand(w, { platforms: ['android'] });
  const other = await brand(w, { platforms: ['android'] });
  const service = appBuildsFor(w.ctx);
  const [x] = await a.run(() => w.builds().request({ platforms: ['android'], requestKey: key() }));
  assert.equal(await other.run(() => service.get(x.id)), null);
  assert.equal((await other.run(() => service.run(x.id))).skipped, true);
  assert.equal(await other.run(() => w.ctx.db.tx((t) => service.markStatus(t, x.id, 'failed', { ifAllowed: true }))), null);
  assert.equal((await other.run(() => service.list({ limit: 50 }))).items.some((b) => b.id === x.id), false);
  assert.equal((await a.builds())[0].status, 'queued');
  // A move the machine does not allow is refused by the code and by the database.
  await assert.rejects(a.run(() => w.ctx.db.tx((t) => service.markStatus(t, x.id, 'submitted'))), /cannot go from queued to submitted/);
  await assert.rejects(w.sql(`UPDATE app_builds SET status = 'submitted' WHERE id = $1`, [x.id]), /cannot go/);
  await assert.rejects(w.sql('UPDATE app_builds SET build_number = 99 WHERE id = $1', [x.id]), /never change/);
});

test('a build the service no longer knows is failed on the next poll, so the platform is free to build again', async () => {
  const b = await brand(w, { platforms: ['android'] });
  const service = w.builds();
  const [x] = await b.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  await b.run(() => service.run(x.id));
  assert.equal((await b.builds())[0].status, 'building');
  await w.eas.post('/reset');
  await service.poll();
  const [row] = await b.builds();
  assert.equal(row.status, 'failed');
  assert.match(row.failed_message, /no longer has this build/);
  const [again] = await b.run(() => service.request({ platforms: ['android'], requestKey: key() }));
  assert.equal(again.status, 'queued');
  assert.equal(again.buildNumber, row.build_number + 1);
});
