// The go-live pack (G-18 to G-20): the check passes on the repository, and each way the pack can drift from the code, a store's
// limits, the company site's claim rules, the apps' declared permissions or a secret makes it fail. Nothing is sent or submitted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PACK, ROOT, allTexts, checkPack, claimProblems, codePermissions, docProblems, fillTemplate, filesUnder, generatedFiles, limitProblems, loadPack, LONGEST_BRAND_NAME,
  permissionProblems, privacyProblems, renderedProblems, screencastProblems, secretProblems, shopperAsked, storeProblems,
} from '../../../tools/review-pack/lib.mjs';
import { main } from '../../../tools/review-pack/index.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));
const template = () => JSON.parse(fs.readFileSync(path.join(ROOT, PACK, 'store/branded-app-template.json'), 'utf8'));

test('the check passes on the repository, and the command exits 0', async () => {
  assert.deepEqual(await checkPack(), []);
  const log = console.log;
  console.log = () => {};
  try { assert.equal(await main([]), 0); } finally { console.log = log; }
});

test('the pack covers exactly the permissions the code asks for, from the adapter scope lists and the go-live contract', async () => {
  const code = await codePermissions();
  const pack = loadPack();
  assert.equal(code.instagram.length, 4);
  assert.equal(code.facebook.length, 5);
  assert.equal(code.whatsapp.length, 2);
  assert.deepEqual(pack.permissions.map((p) => p.name).sort(), [...code.instagram, ...code.facebook, ...code.whatsapp].sort());
  // The permissions document is written from the same list, and names each one with its justification.
  const doc = fs.readFileSync(path.join(ROOT, PACK, 'meta-app-review/permissions.md'), 'utf8');
  for (const p of pack.permissions) assert.ok(doc.includes(`### ${p.name}`) && doc.includes(p.justification), p.name);
});

test('G-18: the check fails when the code asks for a permission the pack does not cover', async () => {
  const code = await codePermissions();
  const asked = { ...clone(code), instagram: [...code.instagram, 'instagram_business_content_publish'], contract: { ...code.contract, instagram: [...code.contract.instagram, 'instagram_business_content_publish'] } };
  const problems = permissionProblems(loadPack(), asked);
  assert.ok(problems.some((p) => p.includes('instagram_business_content_publish') && /does not justify/.test(p)), problems.join('\n'));
});

test('G-18: the check fails when the pack justifies a permission the code no longer asks for', async () => {
  const code = await codePermissions();
  const fewer = { ...clone(code), facebook: code.facebook.filter((n) => n !== 'pages_manage_engagement'), contract: { ...code.contract, facebook: code.contract.facebook.filter((n) => n !== 'pages_manage_engagement') } };
  const problems = permissionProblems(loadPack(), fewer);
  assert.ok(problems.some((p) => p.includes('pages_manage_engagement') && /no longer asks/.test(p)), problems.join('\n'));
});

test('G-18: a webhook field whose permission the pack does not cover fails, and a permission missing its justification text fails', async () => {
  const code = await codePermissions();
  const pack = loadPack();
  const without = { ...pack, permissions: pack.permissions.filter((p) => p.name !== 'instagram_business_manage_comments') };
  assert.ok(permissionProblems(without, code).some((p) => /Webhook field comments needs instagram_business_manage_comments/.test(p)));
  const blank = clone(pack);
  blank.permissions[0].justification = '';
  assert.ok(permissionProblems(blank, code).some((p) => /justification is empty/.test(p)));
});

test('G-19: each permission has a screencast script with every tap and what must be visible, and a rehearsal that exists', () => {
  const pack = loadPack();
  assert.deepEqual(screencastProblems(pack), []);
  const broken = clone(pack);
  broken.permissions[0].screencast = 'sc-99';
  broken.screencasts[1].steps[0].see = '';
  broken.screencasts[0].rehearsal = 'e2e/p9/screencasts/missing.spec.js';
  const problems = screencastProblems(broken);
  assert.ok(problems.some((p) => /sc-99/.test(p)));
  assert.ok(problems.some((p) => /says nothing about what must be visible/.test(p)));
  assert.ok(problems.some((p) => /rehearsal .* does not exist/.test(p)));
});

test('G-19: each rehearsal in the pack is a Playwright flow that records a video and walks the pack\'s own steps', () => {
  const pack = loadPack();
  const rehearsed = pack.screencasts.filter((s) => s.rehearsal);
  assert.ok(rehearsed.length >= 2);
  for (const s of rehearsed) {
    const spec = fs.readFileSync(path.join(ROOT, s.rehearsal), 'utf8');
    assert.ok(spec.includes(`scriptOf('${s.id}')`), `${s.rehearsal} reads ${s.id}`);
    assert.ok(/video: VIDEO/.test(spec), `${s.rehearsal} saves a video`);
    assert.equal((spec.match(/test\.step\(/g) ?? []).length, s.steps.length, `${s.rehearsal} walks every step of ${s.id}`);
    assert.ok(!/sk_live|rzp_live|fetch\('https?:\/\/(?!127\.0\.0\.1|localhost)/.test(spec), 'no real service');
  }
});

test('listing text over a store limit fails, for the owner app\'s listing and the branded template at the longest name', () => {
  const listing = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/owner/store/listing.json'), 'utf8'));
  assert.deepEqual(limitProblems(listing, 'listing'), []);
  const long = clone(listing);
  long.play.shortDescription = 'x'.repeat(81);
  long.appStore.subtitle = 'x'.repeat(31);
  long.appStore.keywords = 'k'.repeat(101);
  long.play.fullDescription = 'x'.repeat(4001);
  assert.equal(limitProblems(long, 'listing').length, 4);
  assert.deepEqual(limitProblems(fillTemplate(template(), LONGEST_BRAND_NAME), 'template'), []);
  const wide = template();
  wide.play.shortDescription = 'Shop {{brand_name}} and track your orders, return items and pay however you like.';
  assert.ok(limitProblems(fillTemplate(wide, LONGEST_BRAND_NAME), 'template').some((p) => /shortDescription is longer than 80/.test(p)), 'fits at a short name, not at 30 characters');
});

test('G-20: the claims the company site bans are caught: a promise of no bans, and Meta-approved before approval', () => {
  const bad = [
    'Meta-approved automation for your shop', 'Approved by Meta', 'We are an official Meta partner', 'Your account will never get banned', 'Ban-proof DMs',
    'We guarantee no bans', 'No bans, ever', 'Safe from bans', '100% safe', 'Never shadowbanned again',
  ];
  for (const text of bad) assert.equal(claimProblems({ 'x.md': text }).length, 1, text);
  const fine = ['Designed to reduce the risk of restrictions, never guaranteed.', 'Built on Meta\'s official API.', 'Advanced Access is requested from Meta.', 'Reach is down 20% vs your usual.'];
  for (const text of fine) assert.deepEqual(claimProblems({ 'x.md': text }), [], text);
});

test('G-20: every document and the owner listing is free of banned claims, secrets and real ids', () => {
  const texts = allTexts();
  assert.ok(Object.keys(texts).length >= 20, 'the scan reads the whole pack');
  assert.deepEqual(claimProblems(texts), []);
  assert.deepEqual(secretProblems(Object.fromEntries(Object.entries(texts).filter(([f]) => f.startsWith(PACK)))), []);
});

test('G-20: a secret, a real account id, a phone number, a server address or a personal email in a document fails', () => {
  const leaks = {
    token: `Use EAAG${'a'.repeat(40)} to sign in`,
    razorpay: 'key rzp_live_AbCdEf123456', // secret-scan:allow
    private: '-----BEGIN PRIVATE KEY-----', // secret-scan:allow
    db: 'postgres://app:hunter2@db.internal/bhava',
    id: 'The account is 17841400000000011',
    phone: 'Sign in as 9123456780',
    phone2: 'Call +91 91234 56780',
    ip: 'The server is at 203.0.113.9',
    email: 'Write to someone@gmail.com',
    hex: `key ${'ab'.repeat(32)}`,
    bearer: `Authorization: Bearer ${'x'.repeat(30)}`,
  };
  for (const [name, text] of Object.entries(leaks)) assert.equal(secretProblems({ 'x.md': text }).length >= 1, true, name);
  for (const ok of ['https://<platform-host>/privacy', 'REVIEW_LOGIN_PHONE and REVIEW_LOGIN_CODE_HASH', 'order 4211', 'someone@example.com', 'at 127.0.0.1', 'Version 1.2.3', '2 to 8 screenshots, 1320x2868']) assert.deepEqual(secretProblems({ 'x.md': ok }), [], ok);
});

test('privacy answers are generated from the apps\' own declarations: a drifted listing, an extra permission or an uncollected type fails', async () => {
  assert.deepEqual(await storeProblems(), []);
  // A permission the shopper app does not ask for, explained in the template.
  const extra = template();
  extra.permissions['android.permission.RECORD_AUDIO'] = 'Record audio.';
  assert.ok((await storeProblems(ROOT, { template: extra })).some((p) => /no longer asks for/.test(p) && /RECORD_AUDIO/.test(p)));
  // A permission the app asks for and the template drops.
  const dropped = template();
  delete dropped.permissions['android.permission.POST_NOTIFICATIONS'];
  assert.ok((await storeProblems(ROOT, { template: dropped })).some((p) => /POST_NOTIFICATIONS and branded-app-template.json does not explain/.test(p)));
  // The app collects a type the store answers do not cover, and the template answers for one it does not collect.
  const collected = template();
  delete collected.collected.address;
  collected.collected.location = collected.collected.name;
  const problems = await storeProblems(ROOT, { template: collected });
  assert.ok(problems.some((p) => /collects address/.test(p)));
  assert.ok(problems.some((p) => /answers for location/.test(p)));
  // The branded text names the platform.
  const named = template();
  named.play.fullDescription += ' Powered by Bhava.';
  assert.ok((await storeProblems(ROOT, { template: named })).some((p) => /names the platform/.test(p)));
  // The permission sentences are the app's own words.
  const sentences = template();
  sentences.permissions.NSCameraUsageDescription = 'Something else.';
  assert.ok((await storeProblems(ROOT, { template: sentences })).some((p) => /camera sentence/.test(p)));
  const shopper = shopperAsked();
  assert.deepEqual([...shopper.asked].sort(), Object.keys(template().permissions).sort());
  assert.equal(shopper.tracking, true);
});

test('the generated documents are what the apps\' answers give, and a hand edit or a stale file fails', async () => {
  const made = await generatedFiles();
  assert.ok(Object.keys(made).length >= 7);
  assert.deepEqual(await renderedProblems(ROOT, made), []);
  const tampered = { ...made, [`${PACK}/store/play-data-safety.md`]: `${made[`${PACK}/store/play-data-safety.md`]}\n| Personal info | Location | yes |` };
  assert.ok((await renderedProblems(ROOT, tampered)).some((p) => /play-data-safety.md is not what its sources give/.test(p)));
  // The data-safety and privacy-label documents hold every kind of data the seller app declares, and say no tracking.
  const collection = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/owner/store/collection.json'), 'utf8'));
  for (const item of collection.items) assert.ok(made[`${PACK}/privacy/collected-data.md`].includes(item.what), item.what);
  assert.match(made[`${PACK}/store/apple-privacy-label.md`], /Used for tracking: no/);
});

test('the public pages match the code: callbacks, the privacy page and the policy pages; every adapter is a named processor', async () => {
  assert.deepEqual(await privacyProblems(), []);
  const pages = JSON.parse(fs.readFileSync(path.join(ROOT, PACK, 'privacy/public-pages.json'), 'utf8')).pages;
  for (const p of ['/privacy', '/meta/deauthorize', '/meta/deletion', '/meta/deletion/:code', '/policies/terms', '/policies/refund', '/policies/shipping', '/policies/privacy']) assert.ok(pages.some((x) => x.path === p), p);
});

test('the narrative documents give the callback addresses, the gates, the reviewer path and the importer\'s own options; nothing says it was submitted', async () => {
  assert.deepEqual(await docProblems(), []);
  const runbook = fs.readFileSync(path.join(ROOT, PACK, 'cutover/runbook.md'), 'utf8');
  // The order a cutover goes in.
  const order = ['## 1. Dry run', '## 2. Freeze', '## 3. Import', '## 4. Checks', '## 5. Switch webhooks and DNS', '## 6. Going back'].map((h) => runbook.indexOf(h));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]));
  assert.equal(loadPack().submitted, false);
});

test('the pack holds only the files it should and no network address of any real service', () => {
  const files = filesUnder(ROOT, PACK);
  assert.ok(files.length >= 20, `${files.length} files`);
  for (const rel of files) {
    assert.ok(/\.(md|json)$/.test(rel), `${rel} is a document, not a recording or a key`);
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const url of text.match(/https?:\/\/[^\s)`'"<>]+/g) ?? []) assert.ok(/<platform-host>/.test(url) || /^https?:\/\/(example\.(com|org)|127\.0\.0\.1)/.test(url), `${rel} has a real address ${url}`);
  }
});
