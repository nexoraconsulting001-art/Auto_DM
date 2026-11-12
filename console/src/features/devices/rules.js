/** How Settings > Devices names a device (AuthDevice), with no React, so node's test runner reads it. */
const PLATFORMS = Object.freeze({ android: 'Android phone', ios: 'iPhone', web: 'Web browser' });

/** { name, kind, detail }: what the person called it (or its platform), what it is, and which app and version. */
export function describeDevice(device) {
  const kind = PLATFORMS[device.platform] ?? 'Device';
  const name = String(device.name ?? '').trim() || kind;
  let detail = '';
  if (device.platform !== 'web') {
    const app = device.app === 'shopper' ? 'Shop app' : 'Bhava for Business';
    detail = device.appVersion ? `${app} ${device.appVersion}` : app;
  }
  return { name, kind: name === kind ? '' : kind, detail };
}
