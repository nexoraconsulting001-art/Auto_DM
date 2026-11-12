/**
 * Writes the two fixture brands CI and the tests build: `node tools/build-brand/fixtures/make-fixtures.mjs`. Both are invented
 * (no real or sample business has these names), their addresses are under the reserved .example domain, and their images are
 * flat shapes drawn here, a few kilobytes each. The files are committed; run this again only to change them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { APP_LINK_PATHS, BrandFile } from '../../../src/contracts/apps.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '../../../apps/shopper/package.json'), 'utf8')).version;

const BRANDS = [
  {
    folder: 'zarvelo', tenantId: 7101, name: 'Zarvelo Home', shortName: 'Zarvelo', scheme: 'zarvelo', domain: 'shop.zarvelo.example',
    android: { package: 'example.zarvelo.shop', versionCode: 3 }, ios: { bundleId: 'example.zarvelo.shop', buildNumber: 3, teamId: 'ZRVL0TEAM1' },
    colors: { primary: '#0E6B5C', on_primary: '#FFFFFF', accent: '#E8A33D', ground: '#FAF7F2', card: '#FFFFFF', ink: '#1C2321', muted: '#5F6B67', line: '#E4DED3' },
    fonts: { heading: 'Fraunces', body: 'Inter' }, splashBackground: '#0E6B5C', shape: 'circle',
  },
  {
    folder: 'quindle', tenantId: 7102, name: 'Quindle Threads', shortName: 'Quindle', scheme: 'quindle', domain: 'www.quindle.example',
    android: { package: 'example.quindle.app', versionCode: 12 }, ios: { bundleId: 'example.quindle.app', buildNumber: 12, teamId: 'QNDL0TEAM2' },
    colors: { primary: '#7A1F3D', on_primary: '#FFFFFF', accent: '#2F6FDB', ground: '#FFFFFF', card: '#F7F3F5', ink: '#20141A', muted: '#6A5A62', line: '#E9DFE4' },
    fonts: { heading: 'Poppins', body: 'Poppins' }, splashBackground: '#FFFFFF', shape: 'square',
  },
];

const svg = (size, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`);
const mark = (shape, size, fill) => (shape === 'circle'
  ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.22}" fill="${fill}"/>`
  : `<rect x="${size * 0.3}" y="${size * 0.3}" width="${size * 0.4}" height="${size * 0.4}" rx="${size * 0.06}" fill="${fill}"/>`);
const png = (buffer, file, { flatten } = {}) => {
  let image = sharp(buffer);
  if (flatten) image = image.flatten({ background: flatten }).removeAlpha();
  return image.png({ compressionLevel: 9, palette: true }).toFile(file);
};

for (const b of BRANDS) {
  const dir = path.join(HERE, b.folder);
  fs.mkdirSync(dir, { recursive: true });
  const on = b.colors.on_primary;
  await png(svg(1024, `<rect width="1024" height="1024" fill="${b.colors.primary}"/>${mark(b.shape, 1024, on)}`), path.join(dir, 'icon.png'), { flatten: b.colors.primary });
  await png(svg(1024, mark(b.shape, 1024, on)), path.join(dir, 'adaptive-foreground.png'));
  await png(svg(1024, `<rect width="1024" height="1024" fill="${b.colors.primary}"/>`), path.join(dir, 'adaptive-background.png'), { flatten: b.colors.primary });
  await png(svg(96, mark(b.shape, 96, '#FFFFFF')), path.join(dir, 'notification.png'));
  await png(svg(1024, mark(b.shape, 1024, b.splashBackground === b.colors.primary ? on : b.colors.primary)), path.join(dir, 'splash.png'));
  const brand = BrandFile.parse({
    schema: 1,
    tenantId: b.tenantId,
    name: b.name,
    shortName: b.shortName,
    scheme: b.scheme,
    appVersion: VERSION,
    runtimeVersion: VERSION,
    shopDomain: b.domain,
    apiBaseUrl: `https://${b.domain}`,
    supportEmail: `help@${b.domain.replace(/^(shop|www)\./, '')}`,
    privacyUrl: `https://${b.domain}/policies/privacy`,
    android: b.android,
    ios: b.ios,
    associatedDomains: [`applinks:${b.domain}`],
    linkHosts: [b.domain],
    linkPaths: APP_LINK_PATHS,
    colors: b.colors,
    fonts: b.fonts,
    splashBackground: b.splashBackground,
    assets: { icon: 'icon.png', adaptiveForeground: 'adaptive-foreground.png', adaptiveBackground: 'adaptive-background.png', notificationIcon: 'notification.png', splash: 'splash.png' },
    payDriver: 'hosted',
    push: { android: false, ios: false },
    updates: { channel: `t${b.tenantId}` },
  });
  fs.writeFileSync(path.join(dir, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`);
  console.log(`fixtures: wrote ${b.folder}`);
}
