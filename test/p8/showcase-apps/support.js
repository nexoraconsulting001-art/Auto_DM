import fs from 'node:fs';
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
