/**
 * Reads the one file a build differs by: the brand file named by the BRAND_FILE setting, with its images beside it. Nothing
 * about any brand is in this source tree; `npm run build-brand` writes the file (tools/build-brand) and checks it in full
 * against the schema (BrandFile in src/contracts/apps.js). This reader only makes sure the file is whole enough to configure
 * a build, and says which key is wrong when it is not. A test keeps BRAND_KEYS equal to the schema's keys.
 *
 * BRAND_FILE is an absolute path, or one relative to apps/shopper.
 */
const fs = require('node:fs');
const path = require('node:path');

const BRAND_KEYS = Object.freeze([
  'schema', 'tenantId', 'name', 'shortName', 'scheme', 'appVersion', 'runtimeVersion', 'shopDomain', 'apiBaseUrl', 'supportEmail', 'privacyUrl',
  'android', 'ios', 'associatedDomains', 'linkHosts', 'linkPaths', 'colors', 'fonts', 'splashBackground', 'assets', 'payDriver', 'push', 'updates',
]);
const ASSET_KEYS = Object.freeze(['icon', 'adaptiveForeground', 'adaptiveBackground', 'notificationIcon', 'splash']);
const PAY_DRIVERS = Object.freeze(['hosted', 'native']);
const HEX = /^#[0-9A-Fa-f]{6}$/;

const fail = (message) => {
  throw new Error(`Brand file: ${message}`);
};

/** The checks a build cannot do without. Throws naming the key. */
function checkBrand(brand) {
  if (!brand || typeof brand !== 'object' || Array.isArray(brand)) fail('it is not an object');
  if (brand.schema !== 1) fail('schema must be 1');
  for (const key of BRAND_KEYS) if (!(key in brand)) fail(`${key} is missing`);
  for (const key of Object.keys(brand)) if (!BRAND_KEYS.includes(key)) fail(`${key} is not a key of a brand file`);
  if (!Number.isInteger(brand.tenantId) || brand.tenantId < 1) fail('tenantId must be a positive whole number');
  for (const key of ['name', 'shortName', 'appVersion', 'runtimeVersion', 'shopDomain', 'supportEmail']) {
    if (typeof brand[key] !== 'string' || !brand[key].trim()) fail(`${key} must be text`);
  }
  if (!/^[a-z][a-z0-9]{2,30}$/.test(brand.scheme)) fail('scheme must be 3 to 31 lower-case letters and digits');
  if (!/^https:\/\/[^/\s]+$/.test(brand.apiBaseUrl)) fail('apiBaseUrl must be an https origin with no path');
  if (!/^https:\/\//.test(brand.privacyUrl)) fail('privacyUrl must start with https://');
  if (!brand.android && !brand.ios) fail('android or ios must be set');
  if (brand.android && (typeof brand.android.package !== 'string' || !Number.isInteger(brand.android.versionCode))) fail('android needs package and versionCode');
  if (brand.ios && (typeof brand.ios.bundleId !== 'string' || !Number.isInteger(brand.ios.buildNumber) || typeof brand.ios.teamId !== 'string')) fail('ios needs bundleId, buildNumber and teamId');
  for (const key of ['associatedDomains', 'linkHosts']) if (!Array.isArray(brand[key])) fail(`${key} must be a list`);
  if (!Array.isArray(brand.linkPaths?.open) || !Array.isArray(brand.linkPaths?.exclude)) fail('linkPaths needs open and exclude');
  if (!brand.colors || !HEX.test(String(brand.colors.primary))) fail('colors.primary must be a colour such as #RRGGBB');
  if (!HEX.test(String(brand.splashBackground))) fail('splashBackground must be a colour such as #RRGGBB');
  if (typeof brand.fonts?.heading !== 'string' || typeof brand.fonts?.body !== 'string') fail('fonts needs heading and body');
  for (const key of ASSET_KEYS) if (!/^[A-Za-z0-9_-]{1,60}\.(png|jpg)$/.test(String(brand.assets?.[key]))) fail(`assets.${key} must be an image file name`);
  if (!PAY_DRIVERS.includes(brand.payDriver)) fail('payDriver must be hosted or native');
  if (typeof brand.push?.android !== 'boolean' || typeof brand.push?.ios !== 'boolean') fail('push needs android and ios');
  if (typeof brand.updates?.channel !== 'string') fail('updates.channel is missing');
  return brand;
}

/**
 * The brand this build is for: { brand, dir, file, asset(key), fonts, fontFamilies }. `asset` answers an image's absolute path
 * and throws when it is not there; `fonts` are the .ttf and .otf files in the brand's `fonts` folder, and `fontFamilies` maps a
 * brand font's name to the family the app uses for it (fonts/families.json), both empty when the brand ships no font file.
 */
function readBrand(env = process.env, baseDir = __dirname) {
  const named = String(env.BRAND_FILE || '').trim();
  if (!named) throw new Error('BRAND_FILE is not set. Every build of this app is for one brand: name its brand file, or run `npm run build-brand -- <slug or brand file>`.');
  const file = path.resolve(baseDir, named);
  if (!fs.existsSync(file)) throw new Error('BRAND_FILE names a file that does not exist.');
  let brand;
  try {
    brand = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Brand file: it is not valid JSON');
  }
  checkBrand(brand);
  const dir = path.dirname(file);
  const asset = (key) => {
    const image = path.join(dir, brand.assets[key]);
    if (!fs.existsSync(image)) fail(`the image ${brand.assets[key]} is not beside it`);
    return image;
  };
  const fontDir = path.join(dir, 'fonts');
  const fonts = fs.existsSync(fontDir) ? fs.readdirSync(fontDir).filter((name) => /\.(ttf|otf)$/i.test(name)).sort().map((name) => path.join(fontDir, name)) : [];
  const familiesFile = path.join(fontDir, 'families.json');
  const fontFamilies = fonts.length && fs.existsSync(familiesFile) ? JSON.parse(fs.readFileSync(familiesFile, 'utf8')) : {};
  return { brand, dir, file, asset, fonts, fontFamilies };
}

/** The pay driver built in: the build setting PAY_DRIVER when it is set, and otherwise what the brand file says. */
const payDriverOf = (brand, env = process.env) => (PAY_DRIVERS.includes(env.PAY_DRIVER) ? env.PAY_DRIVER : brand.payDriver);

module.exports = { ASSET_KEYS, BRAND_KEYS, PAY_DRIVERS, checkBrand, payDriverOf, readBrand };
