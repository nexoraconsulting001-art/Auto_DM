// Manages businesses from the server (until the Platform Console exists).
//   npm run tenant -- list
//   npm run tenant -- create <slug> "<Business name>"
//   OWNER_PASSWORD=... npm run tenant -- owner <slug> <phone>      # password from the environment, never the command line
//   npm run tenant -- domain <slug> <hostname>
//   npm run tenant -- link-ig <slug> <instagram user id> [username]
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { bindTenant, createRepos } from '../src/repos/index.js';

const USAGE = 'Usage: npm run tenant -- list | create <slug> "<name>" | owner <slug> <phone> | domain <slug> <host> | link-ig <slug> <ig user id> [username]';

/** Runs one command and returns the message to print. */
export async function tenantCommand(repos, [command, slug, a, b], { ownerPassword = '' } = {}) {
  const { tenants } = repos;
  if (command === 'list') {
    const all = await tenants.list();
    return all.length ? all.map((t) => `${t.slug}  ${t.name}  (${t.plan}, ${t.status})`).join('\n') : 'No businesses yet.';
  }
  if (command === 'create') {
    if (!slug || !a) throw new Error(USAGE);
    const t = await tenants.create({ slug, name: a });
    return `Created ${t.name} (${t.slug}).`;
  }
  if (!['owner', 'domain', 'link-ig'].includes(command) || !slug || !a) throw new Error(USAGE);
  const tenant = await tenants.getBySlug(slug);
  if (!tenant) throw new Error(`No business called "${slug}".`);
  if (command === 'domain') return `${await tenants.addDomain(tenant.id, a)} now serves ${tenant.name}.`;
  if (command === 'link-ig') {
    await tenants.linkIgAccount(tenant.id, a, b || '');
    return `Instagram account ${a} now belongs to ${tenant.name}.`;
  }
  if (!ownerPassword) throw new Error('Set OWNER_PASSWORD in the environment.');
  const owner = await bindTenant(repos, tenant).users.ensureOwner({ phone: a, password: ownerPassword });
  if (!owner) throw new Error(`"${a}" is not a valid mobile number.`);
  return `${owner.phone} is now the owner of ${tenant.name}.`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openDb({ url: config.databaseUrl, dataDir: config.dataDir });
  try {
    console.log(await tenantCommand(createRepos(db), process.argv.slice(2), { ownerPassword: process.env.OWNER_PASSWORD }));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
