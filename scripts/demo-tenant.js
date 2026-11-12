// The App Review demo business (PRD 10.6, P-24). Its sample is invented: nobody real is in it.
//   node scripts/demo-tenant.js status
//   node scripts/demo-tenant.js ensure [YYYY-MM-DD]    make it when missing or out of date; otherwise leave it
//   node scripts/demo-tenant.js reset  [YYYY-MM-DD]    write it afresh (signs out whoever is in it)
//   node scripts/demo-tenant.js remove
// The day is "today" for the sample (default: today, UTC). The same day always gives the same sample.
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openRuntimeDb } from '../src/db/index.js';
import { demoTenantService } from '../src/modules/demo-tenant/service.js';
import { createSecrets } from '../src/platform/secrets.js';
import { createRepos } from '../src/repos/index.js';

const USAGE = 'Usage: node scripts/demo-tenant.js status | ensure [YYYY-MM-DD] | reset [YYYY-MM-DD] | remove';

const line = (r) => (r.exists
  ? `Demo business ${r.slug} (id ${r.tenantId}): sample v${r.version ?? '-'} for ${r.anchorDay ?? '-'}${r.current ? '' : ', out of date'}`
  : 'No demo business.');

/** Runs one command against `service` and returns the message to print. */
export async function demoTenantCommand(service, [command, day]) {
  if (command === 'status') return line(await service.status());
  if (command === 'ensure' || command === 'reset') {
    const result = await service[command]({ anchorDay: day || undefined });
    const counts = result.counts ? ` (${Object.entries(result.counts).map(([k, v]) => `${v} ${k}`).join(', ')})` : '';
    return `${result.action === 'kept' ? 'Kept' : 'Wrote'}: ${line(result)}${counts}`;
  }
  if (command === 'remove') return (await service.remove()) ? 'Removed the demo business.' : 'No demo business.';
  throw new Error(USAGE);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openRuntimeDb(config);
  try {
    const repos = createRepos(db, { secrets: createSecrets(config) });
    console.log(await demoTenantCommand(demoTenantService({ db, repos, config }), process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
