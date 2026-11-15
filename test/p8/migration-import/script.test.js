// npm run migrate-business: a dry run unless --run, a real run says why and who, and what it prints holds counts and
// codes only, never a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MigrateError, migrateBusiness, parseArgs, printReport } from '../../../scripts/migrate-business.js';
import { USERNAMES, legacyExport, world } from './support.js';

test('the command plans by default, runs only when asked with a reason, names the operator, and prints no personal data', async () => {
  const w = await world();
  const source = await legacyExport();
  const platform = w.ctx.platform;
  const lines = [];
  const dry = await migrateBusiness({ db: w.db, platform, source, options: parseArgs(['--source', 'x.json', '--tenant', 'importing']) });
  assert.equal(dry.mode, 'dry');
  printReport(dry, { run: false }, (line) => lines.push(line));
  assert.match(lines.at(-1), /Dry run: nothing was written/);

  await assert.rejects(migrateBusiness({ db: w.db, platform, source, options: parseArgs(['--source', 'x.json', '--tenant', 'importing', '--run']) }), (err) => err instanceof MigrateError && /--reason/.test(err.message));
  await assert.rejects(migrateBusiness({ db: w.db, platform, source, options: parseArgs(['--source', 'x.json', '--tenant', 'nobody', '--run', '--reason', 'x']) }), /No business has that slug/);
  await assert.rejects(migrateBusiness({ db: w.db, platform, source, options: parseArgs(['--source', 'x.json', '--tenant', 'importing', '--run', '--reason', 'x', '--by', 'who@example.test']) }), /--by/);

  const real = await migrateBusiness({ db: w.db, platform, source, options: parseArgs(['--source', 'x.json', '--tenant', 'importing', '--run', '--reason', 'Moving the old shop', '--by', 'ops@example.test']) });
  assert.equal(real.mode, 'real');
  printReport(real, { run: true }, (line) => lines.push(line));
  assert.match(lines.at(-1), /Imported \(run \d+\)\. The next order number is 4211\./);
  const printed = lines.join('\n');
  for (const secret of [...USERNAMES, '9000000201', 'Rhea', 'IGQ-old']) assert.ok(!printed.includes(secret));
  const [audit] = await w.q(`SELECT actor, details FROM audit_log WHERE tenant_id = $1 AND action = 'business.imported'`, [w.target.id]);
  assert.equal(audit.actor, `platform_user:${w.operatorId}`);
  assert.equal(audit.details.reason, 'Moving the old shop');
});
