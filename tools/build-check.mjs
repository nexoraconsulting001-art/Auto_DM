/**
 * Checks on what the app builds produced (PRD 10.1, P-02), run by .github/workflows/apps.yml on the tools' own output:
 *
 *   aapt2 dump badging app.apk | node tools/build-check.mjs apk [--package com.example.app]
 *       the APK targets API 36 or higher (Google Play's minimum from 31 Aug 2026), and is the package it should be
 *   (xcodebuild -version; xcodebuild -showsdks) | node tools/build-check.mjs xcode
 *       the build ran on Xcode 26 or newer with an iOS 26 simulator SDK or newer (App Store's minimum from 28 Apr 2026)
 *
 * Each prints what it found and exits 1 with the reason when the rule is broken.
 */
import { pathToFileURL } from 'node:url';

export const MIN_TARGET_SDK = 36;
export const MIN_XCODE = 26;
export const MIN_IOS_SDK = 26;

/** From `aapt2 dump badging`: { ok, targetSdk, minSdk, packageName, problems }. */
export function checkApkBadging(text, { minTarget = MIN_TARGET_SDK, packageName } = {}) {
  const pick = (pattern) => pattern.exec(String(text))?.[1];
  const found = {
    packageName: pick(/^package: name='([^']+)'/m),
    targetSdk: Number(pick(/^targetSdkVersion:'(\d+)'/m)),
    minSdk: Number(pick(/^(?:sdkVersion|minSdkVersion):'(\d+)'/m)),
    debuggable: /^application-debuggable/m.test(String(text)),
  };
  const problems = [];
  if (!found.packageName) problems.push('This is not the output of aapt2 dump badging: no package line');
  if (!Number.isInteger(found.targetSdk)) problems.push('No targetSdkVersion in the APK');
  else if (found.targetSdk < minTarget) problems.push(`targetSdkVersion is ${found.targetSdk}; it must be ${minTarget} or higher`);
  if (packageName && found.packageName && found.packageName !== packageName) problems.push(`The APK is ${found.packageName}, not ${packageName}`);
  if (found.debuggable) problems.push('The APK is debuggable: this is not a release build');
  return { ok: problems.length === 0, ...found, problems };
}

/** From `xcodebuild -version` followed by `xcodebuild -showsdks`: { ok, xcode, iosSdk, problems }. */
export function checkXcode(text, { minXcode = MIN_XCODE, minSdk = MIN_IOS_SDK } = {}) {
  const xcode = /^Xcode (\d+(?:\.\d+)*)/m.exec(String(text))?.[1] ?? null;
  const sdks = [...String(text).matchAll(/-sdk iphonesimulator(\d+(?:\.\d+)*)/g)].map((m) => m[1]);
  const major = (version) => Number(String(version).split('.')[0]);
  const iosSdk = sdks.sort((a, b) => major(b) - major(a) || Number(b.split('.')[1] ?? 0) - Number(a.split('.')[1] ?? 0))[0] ?? null;
  const problems = [];
  if (!xcode) problems.push('No Xcode version found: pass the output of xcodebuild -version');
  else if (major(xcode) < minXcode) problems.push(`Xcode is ${xcode}; the build needs Xcode ${minXcode} or newer`);
  if (!iosSdk) problems.push('No iOS simulator SDK found: pass the output of xcodebuild -showsdks');
  else if (major(iosSdk) < minSdk) problems.push(`The iOS SDK is ${iosSdk}; the build needs the iOS ${minSdk} SDK or newer`);
  return { ok: problems.length === 0, xcode, iosSdk, problems };
}

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, ...rest] = process.argv.slice(2);
  const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const text = await stdin();
  let result;
  if (kind === 'apk') {
    result = checkApkBadging(text, { packageName: option('--package') });
    console.log(`build-check: package ${result.packageName}, targetSdkVersion ${result.targetSdk}, minSdkVersion ${result.minSdk}`);
  } else if (kind === 'xcode') {
    result = checkXcode(text);
    console.log(`build-check: Xcode ${result.xcode}, iOS simulator SDK ${result.iosSdk}`);
  } else {
    console.error('Usage: node tools/build-check.mjs apk [--package id] | xcode   (reads the tool output on stdin)');
    process.exit(2);
  }
  for (const problem of result.problems) console.error(`build-check: ${problem}`);
  process.exit(result.ok ? 0 : 1);
}
