/**
 * The pure parts of the showcase build (Phase 8, Q-11): settings, the iOS brand file, the checks on a built APK, the order
 * numbers and flow values, and the install note. Nothing here reads a database, starts a process or names a business: which
 * businesses exist is seed/showcase/manifest.json, and a flow reaches one by its place in that list (1, 2, ...).
 */
import { readZip, termsOf, termsIn, PLATFORM_TERM } from '../../apps/shopper/.maestro/support/scan-binary.mjs';

export { readZip };

/** The one setting a hand run changes to point the builds and the flows at another server (the QA server's address). */
export const API_SETTING = 'SHOWCASE_API_URL';
/** Where a build run on a runner reaches the job's own server from: an emulator's name for the machine, or a simulator's. */
export const DEFAULT_API = Object.freeze({ android: 'http://10.0.2.2:3000', ios: 'http://localhost:3000' });

export class ShowcaseBuildError extends Error {}

/** The server address for a platform: SHOWCASE_API_URL, else the runner's own. An origin only: no path, no secret in it. */
export function apiUrl(platform, env = process.env) {
  const given = String(env[API_SETTING] ?? '').trim().replace(/\/+$/, '');
  const url = given || DEFAULT_API[platform];
  if (!url) throw new ShowcaseBuildError(`No platform called ${platform}`);
  if (!/^https?:\/\/[^/\s@?#]+$/.test(url)) throw new ShowcaseBuildError(`${API_SETTING} must be an address such as http://10.0.2.2:3000, with no path, login or query`);
  return url;
}

/** The brand file the iOS simulator build is made from: the Android one with the iOS block in place of the Android block. A sample has no Apple account, so the team id is a placeholder the simulator build never uses. */
export function iosBrandFile(brand, { buildNumber = 1 } = {}) {
  if (!brand?.android?.package) throw new ShowcaseBuildError('The brand file has no Android package to take the iOS bundle id from');
  return { ...brand, android: null, ios: { bundleId: brand.android.package, buildNumber, teamId: '0000000000' } };
}

/** Whether `text` holds a private key, keystore content or one of `secrets`. Used on build logs and on what is written to disk. */
export const SECRET_SHAPES = Object.freeze([/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, /(?:MIIK|MIIJ|MIIL|\/u3\+7QAAAA)[A-Za-z0-9+/]{200,}/]);
export function holdsSecret(text, secrets = []) {
  const body = String(text);
  return SECRET_SHAPES.some((shape) => shape.test(body)) || secrets.some((value) => typeof value === 'string' && value.length >= 8 && body.includes(value));
}

const hexBytes = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Buffer.from([b, g, r, 0xff]); // an Android resource colour is ARGB, stored little-endian
};
const textHas = (buffer, hex) => {
  const needle = hex.toLowerCase();
  return [buffer.toString('latin1'), buffer.toString('utf16le'), buffer.subarray(1).toString('utf16le')].some((text) => text.toLowerCase().includes(needle));
};

/**
 * What a built shopper APK must hold for its business: its icon, its colours, and (from the brand's other businesses) none
 * of their names, and nowhere the platform's name. `entries` is readZip(apk). Answers { ok, problems: [string] }; a problem
 * names a file or a colour role, never the text around a match.
 */
export function verifyApkBrand(entries, brand, { others = [] } = {}) {
  const problems = [];
  const launcher = entries.filter((entry) => /^res\/[^/]*(?:mipmap|drawable)[^/]*\/(?:ic_launcher|ic_launcher_foreground|ic_launcher_background)[^/]*\.(?:png|webp|xml)$/.test(entry.name));
  if (!launcher.length) problems.push('The APK has no launcher icon');
  const resources = entries.find((entry) => entry.name === 'resources.arsc');
  const code = entries.filter((entry) => /^assets\/index\.android\.bundle$|^classes\d*\.dex$/.test(entry.name));
  const resourceBytes = resources ? resources.read() : null;
  const roles = { splashBackground: brand.splashBackground, ...Object.fromEntries(Object.entries(brand.colors ?? {}).map(([role, hex]) => [`colors.${role}`, hex])) };
  for (const [role, hex] of Object.entries(roles)) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(String(hex))) continue;
    const inResources = resourceBytes && (resourceBytes.includes(hexBytes(hex)) || textHas(resourceBytes, hex));
    const inCode = code.some((entry) => textHas(entry.read(), hex));
    if (!inResources && !inCode) problems.push(`The colour ${role} is not in the APK`);
  }
  if (!resources) problems.push('The APK has no resources.arsc');
  for (const entry of entries) {
    const buffer = entry.read();
    if (termsIn(entry.name, buffer, [PLATFORM_TERM]).length) problems.push(`The platform name is in ${entry.name}`);
    const own = termsOf(brand);
    const foreign = [...new Set(others.flatMap(termsOf))].filter((term) => !own.some((mine) => mine.includes(term) || term.includes(mine)));
    if (foreign.length && termsIn(entry.name, buffer, foreign).length) problems.push(`Another business is in ${entry.name}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Order numbers of the seeded cash on delivery orders: one per business, by its place in the manifest (1, 2, ...). */
export const orderNumber = (index) => `SC-${index}-1001`;
/** The phone of the one owner account that belongs to every business of the showcase, so the owner app can switch between them. Invented. */
export const OPERATOR = Object.freeze({ name: 'Showcase Operator', phone: '9000000199' });

/** NAME=value lines for Maestro's -e flags. A value never holds a newline. */
export const envLines = (env) => `${Object.entries(env).map(([name, value]) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new ShowcaseBuildError(`${name} is not a flow value name`);
  if (/[\r\n]/.test(String(value))) throw new ShowcaseBuildError(`${name} holds a line break`);
  return `${name}=${value}`;
}).join('\n')}\n`;

/** The values the owner flows are told, by each business's place in the list: BUSINESS_1_ID, BUSINESS_1_NAME, ORDER_1_ID, ORDER_1_NUMBER ... */
export function ownerFlowEnv(seeded, { apiUrl: api, whatsappUrl, appHost }) {
  const env = { API_URL: api, SIM_WHATSAPP_URL: whatsappUrl, SIGN_IN_HOST: appHost, PHONE_OPERATOR: OPERATOR.phone, BUSINESS_COUNT: String(seeded.length) };
  seeded.forEach((business, i) => {
    const n = i + 1;
    env[`BUSINESS_${n}_ID`] = String(business.tenantId);
    env[`BUSINESS_${n}_NAME`] = business.name;
    env[`ORDER_${n}_ID`] = String(business.order.id);
    env[`ORDER_${n}_NUMBER`] = business.order.number;
  });
  return env;
}

/** The note that goes with the APKs. `builds` is [{ name, shortName, package, file }]. No address of any server but the sample's own. */
export function installNote({ builds, apiUrl: api, owner = null }) {
  const lines = ['Showcase apps: how to install', '',
    'These are sample businesses built from the showcase seed files. They hold no real data and need no account.', '',
    'Each shopper app talks to the sample server given below, so it shows a catalogue only while that server is running.',
    `Server address built in: ${api}`, ''];
  for (const build of builds) lines.push(`- ${build.shortName} (${build.name}): ${build.file}, package ${build.package}`);
  if (owner) lines.push(`- Owner app: ${owner.file}`);
  lines.push('', 'Install on a phone or an emulator with: adb install -r <file>.apk',
    'The apps are signed with a key made for the build and thrown away, so a later build installs over it only after the old one is removed.',
    'To build against another server, set SHOWCASE_API_URL to its address and run tools/showcase-build again.');
  return `${lines.join('\n')}\n`;
}
