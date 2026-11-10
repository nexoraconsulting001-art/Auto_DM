// Changes someone's role in a business. Run it on the server; nothing on the website can do this.
//
//   npm run role -- list                   # the business's owners and staff
//   npm run role -- 9876543210 owner       # make a signed-up account an owner
//   npm run role -- 9876543210 staff
//   npm run role -- 9876543210 staff orders,catalog   # and what they may use
//   npm run role -- 9876543210 manager
//   npm run role -- 9876543210 customer    # back to a normal shopper
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openRuntimeDb } from '../src/db/index.js';
import { createRepos } from '../src/repos/index.js';
import { withTenant } from '../src/tenancy.js';
import { normalizePhone } from '../src/util.js';
import { BUSINESS_ROLES } from '../src/repos/users.js';

const withArticle = (role) => (role === 'owner' ? 'an owner' : `a ${role}`);

/** Returns a one-line result message, or throws with a reason. */
export async function changeRole(repos, { phone, role, ownerPhone = '' }) {
  if (!BUSINESS_ROLES.includes(role)) throw new Error('The role must be "manager", "owner", "staff" or "customer".');
  const user = await repos.users.findByPhone(phone);
  if (!user) throw new Error(`No account with the number ${phone}. Ask them to sign up on the website first.`);
  if (role !== 'owner' && ownerPhone && user.phone === normalizePhone(ownerPhone)) {
    throw new Error('That is the owner from ADMIN_PHONE in .env. It is made owner again on every start; change .env instead.');
  }
  if (user.role === role) return `${user.name} (${user.phone}) is already ${withArticle(role)}.`;
  await repos.users.setRole(user.id, role);
  return `${user.name} (${user.phone}) is now ${withArticle(role)}.`;
}

async function main() {
  const [first, role, permissions] = process.argv.slice(2);
  if (!first) {
    console.log('Usage: npm run role -- list | npm run role -- <phone> owner|manager|staff|customer [permissions, comma separated]');
    process.exit(1);
  }
  const db = await openRuntimeDb(config);
  const repos = createRepos(db);
  try {
    // Which business: TENANT=<slug>, or the default business.
    const slug = process.env.TENANT || config.defaultTenant;
    const tenant = slug ? await repos.tenants.getBySlug(slug) : null;
    if (!tenant) throw new Error(`No business called "${slug}". Run with TENANT=<business slug>.`);
    await withTenant(tenant, async () => {
      if (first === 'list') {
        const team = await repos.users.listTeam();
        console.log(team.length ? team.map((u) => `${u.phone}  ${u.name}  (${u.role})`).join('\n') : 'No owners or staff yet.');
      } else {
        console.log(await changeRole(repos, { phone: first, role, ownerPhone: config.adminPhone }));
        if (role === 'staff' && permissions !== undefined) {
          const user = await repos.users.findByPhone(first);
          await repos.users.setPermissions(user.id, permissions.split(',').filter(Boolean));
          console.log(`They may use: ${permissions || 'nothing yet'}.`);
        }
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
