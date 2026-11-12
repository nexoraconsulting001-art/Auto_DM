// Manages Bhava's own team, who sign in on the platform host. The password comes from the environment, never the command line.
//   npm run platform-user -- list
//   PLATFORM_PASSWORD=... npm run platform-user -- add <email> <super_admin|support|onboarding|service_operator> ["Name"]
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openRuntimeDb } from '../src/db/index.js';
import { createRepos } from '../src/repos/index.js';

const USAGE = 'Usage: npm run platform-user -- list | add <email> <super_admin|support|onboarding|service_operator> ["Name"]';

/** Runs one command and returns the message to print. */
export async function platformUserCommand(repos, [command, email, role, name], { password = '' } = {}) {
  if (command === 'list') {
    const all = await repos.platformUsers.list();
    return all.length ? all.map((u) => `${u.email}  ${u.role}`).join('\n') : 'No platform users yet.';
  }
  if (command !== 'add' || !email || !role) throw new Error(USAGE);
  if (!password) throw new Error('Set PLATFORM_PASSWORD in the environment.');
  const user = await repos.platformUsers.create({ email, role, name, password });
  return `Added ${user.email} as ${user.role}.`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openRuntimeDb(config);
  try {
    console.log(await platformUserCommand(createRepos(db), process.argv.slice(2), { password: process.env.PLATFORM_PASSWORD }));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
