// Postgres is the only runtime database; the built-in one needs an explicit opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openRuntimeDb } from '../../../src/db/index.js';
import { repoRoot } from './support.js';

const refused = /DATABASE_URL is required/;

for (const entry of ['src/server.js', 'src/worker.js']) {
  test(`${entry} refuses to start without DATABASE_URL`, () => {
    const run = spawnSync(process.execPath, [entry], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'production', ALLOW_PGLITE: '' },
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, refused);
  });
}

test('without DATABASE_URL only NODE_ENV=test or ALLOW_PGLITE=1 opens the built-in database', async () => {
  const config = { databaseUrl: '', dataDir: undefined };
  await assert.rejects(openRuntimeDb(config, {}), refused);
  await assert.rejects(openRuntimeDb(config, { NODE_ENV: 'production' }), refused);
  await assert.rejects(openRuntimeDb(config, { ALLOW_PGLITE: '0' }), refused);
  await assert.rejects(openRuntimeDb(config, { ALLOW_PGLITE: 'true' }), refused);
  for (const env of [{ NODE_ENV: 'test' }, { ALLOW_PGLITE: '1' }]) {
    const db = await openRuntimeDb(config, env);
    assert.equal(db.kind, 'pglite');
    await db.close();
  }
});
