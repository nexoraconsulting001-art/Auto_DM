import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES } from '../../../src/modules/index.js';
import { createPlatform } from '../../../src/platform/index.js';
import { createRepos } from '../../../src/repos/index.js';
import { currentTenant, tenantId } from '../../../src/tenancy.js';
import { registerJobs } from '../../../src/worker.js';
import { openTestDb, startApp } from '../../helpers.js';
import { at } from './support.js';

test('the registry lists modules that each have a name', () => {
  assert.ok(MODULES.length >= 4);
  assert.equal(new Set(MODULES.map((m) => m.name)).size, MODULES.length);
  assert.ok(MODULES.every((m) => typeof m.name === 'string' && m.name));
});

test('createRepos adds each module\'s repos and refuses a duplicate name', async () => {
  const db = await openTestDb();
  const seen = [];
  const probe = { name: 'probe', repos: (given, deps) => { seen.push([given, Object.keys(deps).sort()]); return { probeRepo: { hello: () => 'hi' } }; } };
  const repos = createRepos(db, { modules: [probe] });
  assert.equal(repos.probeRepo.hello(), 'hi');
  assert.deepEqual(seen[0][1], ['secrets', 'storage']);
  assert.equal(seen[0][0], db);
  assert.throws(() => createRepos(db, { modules: [probe, probe] }), /both define the repo "probeRepo"/);
  assert.throws(() => createRepos(db, { modules: [{ name: 'clash', repos: () => ({ products: {} }) }] }), /both define the repo "products"/);
});

test('createApp mounts each module: before the business is known, and inside it', async () => {
  const probe = {
    name: 'probe',
    beforeTenant(app) {
      app.get('/probe/before', (_req, res) => res.json({ tenant: currentTenant() }));
    },
    routes(app, ctx) {
      assert.ok(ctx.repos && ctx.auth && ctx.config && ctx.platform && ctx.db && ctx.ig && ctx.modules);
      app.get('/probe/inside', (req, res) => res.json({ tenant: tenantId(), user: req.user?.role ?? null, csrf: Boolean(req.csrf) }));
    },
  };
  const app = await startApp({ modules: [...MODULES, probe], overrides: { defaultTenant: '' } });
  try {
    await app.platform.tenants.addDomain(app.tenant.id, 'default.example');
    const before = await fetch(`${app.base}/probe/before`, { headers: at('nobody.example') });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { tenant: null });

    assert.equal((await fetch(`${app.base}/probe/inside`, { headers: at('nobody.example') })).status, 404);
    const inside = await fetch(`${app.base}/probe/inside`, { headers: at('default.example') });
    assert.deepEqual(await inside.json(), { tenant: app.tenant.id, user: null, csrf: false });
  } finally {
    app.close();
  }
});

test('a module\'s POST routes are behind CSRF like the rest', async () => {
  const { login } = await import('../../helpers.js');
  const probe = { name: 'probe', routes(app) { app.post('/probe/save', (_req, res) => res.json({ ok: true })); } };
  const app = await startApp({ modules: [...MODULES, probe] });
  try {
    const { cookie, csrf } = await login(app.base);
    assert.equal((await fetch(`${app.base}/probe/save`, { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${app.base}/probe/save`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } })).status, 200);
  } finally {
    app.close();
  }
});

test('registerJobs runs each module\'s jobs and schedule', async () => {
  const db = await openTestDb();
  const platform = createPlatform({ storageDriver: 'memory', queueDriver: 'pg', analyticsDriver: 'pg', cacheDriver: 'memory' }, { db });
  const worked = [];
  const queue = { ...platform.queue, every: platform.queue.every.bind(platform.queue), enqueue: platform.queue.enqueue, work: (name) => worked.push(name) };
  let scheduled = 0;
  const probe = {
    name: 'probe',
    jobs({ db: givenDb, repos, platform: givenPlatform, config }) {
      assert.equal(givenDb, db);
      assert.ok(repos.products && config);
      givenPlatform.queue.work('probe.job', async () => {});
      return async () => { scheduled++; };
    },
  };
  const noSchedule = { name: 'quiet', jobs() {} };
  const schedule = registerJobs({ db, platform: { ...platform, queue }, config: { backupStorageDriver: '' }, modules: [probe, noSchedule] });
  assert.ok(worked.includes('probe.job'));
  await schedule();
  await schedule();
  assert.equal(scheduled, 2);
});
