import fs from 'node:fs';
import { inventedPerson } from '../../../src/contracts/seed.js';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** A zip of stored or deflated files, as `readZip` reads one: [{ name, data }]. */
export function makeZip(files, { deflate = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** Two made-up brand files, shaped like the ones the app config service makes. */
export const brandOf = (n, extra = {}) => ({
  schema: 1,
  tenantId: n,
  name: ['Alpha Goods', 'Zeta Plants'][n - 1],
  shortName: ['Alpha', 'Zeta'][n - 1],
  scheme: ['alphagoods', 'zetaplants'][n - 1],
  appVersion: '1.0.0',
  runtimeVersion: '1.0.0',
  shopDomain: ['alpha-goods.example.test', 'zeta-plants.example.test'][n - 1],
  apiBaseUrl: `https://${['alpha-goods', 'zeta-plants'][n - 1]}.example.test`,
  supportEmail: `help@${['alpha-goods', 'zeta-plants'][n - 1]}.example.test`,
  privacyUrl: `https://${['alpha-goods', 'zeta-plants'][n - 1]}.example.test/privacy`,
  android: { package: ['app.sample.alphagoods', 'app.sample.zetaplants'][n - 1], versionCode: 1 },
  ios: null,
  associatedDomains: [],
  linkHosts: [`${['alpha-goods', 'zeta-plants'][n - 1]}.example.test`],
  linkPaths: { open: ['/p/*'], exclude: [] },
  colors: { primary: ['#D4A72C', '#2E7D4F'][n - 1] },
  fonts: { heading: 'Figtree', body: 'Figtree' },
  splashBackground: ['#FFF8E6', '#F4EFE6'][n - 1],
  assets: { icon: 'icon.png', adaptiveForeground: 'fg.png', adaptiveBackground: 'bg.png', notificationIcon: 'n.png', splash: 's.png' },
  payDriver: 'hosted',
  push: { android: false, ios: false },
  updates: { channel: `t${n}` },
  ...extra,
});

const hexColour = (hex) => Buffer.from([parseInt(hex.slice(5, 7), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(1, 3), 16), 0xff]);

/** The files of an APK that is right for brand `n`; `without` names files to leave out, `add` adds files. */
export function apkFiles(n, { without = [], add = [] } = {}) {
  const brand = brandOf(n);
  const files = [
    { name: 'AndroidManifest.xml', data: Buffer.from(brand.android.package, 'utf16le') },
    { name: 'resources.arsc', data: Buffer.concat([Buffer.from(brand.shortName, 'utf16le'), hexColour(brand.splashBackground), hexColour(brand.colors.primary)]) },
    { name: 'res/mipmap-hdpi/ic_launcher.png', data: Buffer.from(`icon-${n}`) },
    { name: 'assets/index.android.bundle', data: Buffer.from(`const brand = "${brand.colors.primary}";`) },
  ].filter((file) => !without.includes(file.name));
  return [...files, ...add];
}

export const KEYS = ['first', 'second'];

/** A manifest of two businesses derived from the committed plant seed, each with its own slug, Instagram account, owner, package and scheme. */
export function smallManifest(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Four products, two of them with no option to choose, and one reel: the same shape as the committed seed, loaded in a fraction of the time.
  const plants = JSON.parse(read('seed/showcase/plants.json'));
  plants.products = [plants.products[0], plants.products[1], plants.products[9], plants.products[10]];
  const used = new Set(plants.products.flatMap((product) => product.categories));
  plants.categories = plants.categories.filter((category) => used.has(category.name));
  fs.writeFileSync(path.join(dir, 'plants.json'), JSON.stringify(plants));
  const names = plants.products.map((product) => product.name);
  const source = JSON.parse(read('seed/showcase/plant-store.json'));
  const labels = [['Small One', 'one', 'One'], ['Small Two', 'two', 'Two']];
  KEYS.forEach((key, i) => {
    const [name, word, short] = labels[i];
    const seed = JSON.parse(JSON.stringify(source));
    const person = inventedPerson(10 + i);
    Object.assign(seed.business, { slug: `small-${word}`, name, legalName: `${name} (sample business)`, igUsername: person.igUsername, igUserId: person.igUserId });
    Object.assign(seed.business.owner, { name: person.name, phone: person.phone, email: person.email });
    Object.assign(seed.app, { appName: name, shortName: short, urlScheme: `small${word}`, androidPackage: `app.sample.small${word}`, supportEmail: `help@small-${word}.example` });
    seed.settings = { ...seed.settings, store_name: name, support_email: `help@small-${word}.example`, support_whatsapp: person.phone.slice(1) };
    seed.products = { from: 'file', file: 'plants.json', format: 'bhava' };
    const reel = { ...seed.reels[0], igMediaId: `90002000000002${i}0`, categories: [], products: names, fill: 0 };
    seed.reels = [reel];
    seed.landingPages = [{ ...seed.landingPages[0], reel: reel.key, categories: [], products: names, fill: 0 }];
    seed.automations = [{ ...seed.automations[0], reel: reel.key, link: { type: 'bhava_page', page: seed.landingPages[0].slug, url: '' } }];
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(seed));
  });
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, businesses: KEYS.map((key) => ({ key, file: `${key}.json` })) }));
  return manifest;
}
