// Not a test: opens the console world and keeps it running so the console can be looked at in a browser by hand.
// node test/p7/platform-ui/serve.dev.mjs   (prints the address and a session cookie, then waits)
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
require('sharp');
require('semver');
const { openConsoleWorld, shopOn, HOST } = await import('../../../e2e/p7/platform/support.js');

const world = await openConsoleWorld();
const shop = await shopOn(world, 't3');
const admin = await world.operator('super_admin');
const support = await world.operator('support');
const info = { url: world.consoleUrl('/'), shop: shop.tenantId, admin: admin.cookie, support: support.cookie, host: HOST, port: world.port };
fs.writeFileSync(process.argv[2] ?? 'serve.json', JSON.stringify(info, null, 2));
console.log('READY', JSON.stringify(info));
setInterval(() => {}, 1 << 30);
