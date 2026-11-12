/**
 * Picks the simulator to take the App Store listing screenshots on: the newest 6.9 inch iPhone (a Pro Max) that is installed.
 *
 *   xcrun simctl list devices available -j | node tools/listing-shots/pick-simulator.mjs      prints its UDID
 *
 * Exits 1 with the reason when there is none.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** From `simctl list devices -j`: the UDID of the newest iOS runtime's last iPhone Pro Max, or null. */
export function pickSimulator(listing) {
  const version = (runtime) => runtime.match(/iOS-(\d+(?:-\d+)*)/)?.[1].split('-').map(Number) ?? [];
  const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };
  const runtimes = Object.keys(listing.devices ?? {}).filter((key) => version(key).length).sort((a, b) => newer(version(b), version(a)));
  for (const runtime of runtimes) {
    const found = listing.devices[runtime].filter((device) => /^iPhone .*Pro Max$/.test(device.name) && device.isAvailable !== false);
    if (found.length) return found[found.length - 1].udid;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const udid = pickSimulator(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!udid) {
    console.error('pick-simulator: no 6.9 inch iPhone (a Pro Max) is installed');
    process.exit(1);
  }
  console.log(udid);
}
