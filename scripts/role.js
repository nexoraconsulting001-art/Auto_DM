// Gives or removes admin rights. Run it on the server; nothing on the website can make someone an admin.
//
//   npm run role -- list                   # who is an admin
//   npm run role -- 9876543210 admin       # make a signed-up account an admin
//   npm run role -- 9876543210 customer    # back to a normal shopper
//
// With the built-in database, stop the app first (only one process can open it):
//   docker compose stop web && docker compose run --rm web npm run role -- 9876543210 admin && docker compose start web
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createRepos } from '../src/repos/index.js';
import { withTenant } from '../src/tenancy.js';
import { normalizePhone } from '../src/util.js';

/** Returns a one-line result message, or throws with a reason. */
export async function changeRole(repos, { phone, role, ownerPhone = '' }) {
  if (!['admin', 'customer'].includes(role)) throw new Error('The role must be "admin" or "customer".');
  const user = await repos.users.findByPhone(phone);
  if (!user) throw new Error(`No account with the number ${phone}. Ask them to sign up on the website first.`);
  if (role === 'customer' && ownerPhone && user.phone === normalizePhone(ownerPhone)) {
    throw new Error('That is the owner from ADMIN_PHONE in .env. It is made admin again on every start; change .env instead.');
  }
  if (user.role === role) return `${user.name} (${user.phone}) is already ${role === 'admin' ? 'an admin' : 'a customer'}.`;
  await repos.users.setRole(user.id, role);
  return role === 'admin'
    ? `${user.name} (${user.phone}) is now an admin. They log in on /login with their own password.`
    : `${user.name} (${user.phone}) is now a customer.`;
}

async function main() {
  const [first, role] = process.argv.slice(2);
  if (!first) {
    console.log('Usage: npm run role -- list | npm run role -- <phone> admin | npm run role -- <phone> customer');
    process.exit(1);
  }
  const db = await openDb({ url: config.databaseUrl, dataDir: config.dataDir });
  const repos = createRepos(db);
  try {
    // Which business: TENANT=<slug>, or the default business.
    const slug = process.env.TENANT || config.defaultTenant;
    const tenant = slug ? await repos.tenants.getBySlug(slug) : null;
    if (!tenant) throw new Error(`No business called "${slug}". Run with TENANT=<business slug>.`);
    await withTenant(tenant, async () => {
      if (first === 'list') {
        const admins = await repos.users.listAdmins();
        console.log(admins.length ? admins.map((u) => `${u.phone}  ${u.name}`).join('\n') : 'No admins yet.');
      } else {
        console.log(await changeRole(repos, { phone: first, role, ownerPhone: config.adminPhone }));
      }
    });
  } finally {
    await db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
