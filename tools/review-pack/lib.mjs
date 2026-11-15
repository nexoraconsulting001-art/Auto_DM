/**
 * The go-live pack's checks, as functions over the repository (PRD 4.15, 10.6, 12, 13; G-18 to G-20). Every check returns
 * a list of problems, each a sentence naming the file. Nothing here talks to a network, sends, or submits.
 *
 *   permissionProblems     the permissions the code asks for = the permissions the pack justifies, both ways
 *   screencastProblems     every permission has a script, every script has taps and what must be visible, rehearsals exist
 *   claimProblems          text a store or Meta would read, against the company site's claim rules
 *   limitProblems          listing text against each store's limits (the branded template at a 30 character name)
 *   secretProblems         no secret, real account id, personal number, address or email in any document
 *   storeProblems          the owner app's own store check, plus the branded template against the shopper app and DATA_COLLECTED
 *   privacyProblems        public pages against the code, processors against the adapters, the retention and DPDP files exist
 *   docProblems            the narrative documents mention what the code defines (callbacks, gates, importer options)
 *   renderedProblems       the generated documents are what the sources give
 *
 * `generatedFiles()` is the one place the generated documents are made; `--write` writes them, the check compares them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PACK = 'docs/go-live';

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (root, rel) => JSON.parse(read(root, rel));
const norm = (text) => text.replace(/\r\n/g, '\n');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const chars = (text) => [...String(text)].length;

export const loadPack = (root = ROOT) => readJson(root, `${PACK}/meta-app-review/pack.json`);

/** Every file under a folder, as repository-relative paths with forward slashes. */
export function filesUnder(root, rel) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  if (exists(root, rel)) walk(rel);
  return out;
}

// ---- what the code asks for ----

/** The permissions the code asks for, by group, read from the Meta adapter's scope lists and the go-live contract. */
export async function codePermissions(root = ROOT) {
  const url = (rel) => new URL(`file:///${path.join(root, rel).replace(/\\/g, '/')}`).href;
  const login = await import(url('src/adapters/meta/login.js'));
  const contract = await import(url('src/contracts/golive.js'));
  const rules = await import(url('src/modules/ig-connect/rules.js'));
  return {
    instagram: [...login.INSTAGRAM_SCOPES],
    facebook: [...login.FACEBOOK_SCOPES],
    // No adapter lists WhatsApp scopes: the go-live contract is where the code names them.
    whatsapp: [...contract.META_PERMISSIONS.whatsapp],
    contract: Object.fromEntries(Object.entries(contract.META_PERMISSIONS).map(([k, v]) => [k, [...v]])),
    webhookFieldScopes: { ...rules.WEBHOOK_FIELD_SCOPES },
    gates: null,
  };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

export function permissionProblems(pack, code) {
  const problems = [];
  const packNames = pack.permissions.map((p) => p.name);
  if (new Set(packNames).size !== packNames.length) problems.push('pack.json lists a permission twice');
  for (const group of ['instagram', 'facebook', 'whatsapp']) {
    const asked = code[group];
    const justified = pack.permissions.filter((p) => p.group === group).map((p) => p.name);
    for (const name of asked) if (!justified.includes(name)) problems.push(`The code asks for ${name} (${group}) and the review pack does not justify it`);
    for (const name of justified) if (!asked.includes(name)) problems.push(`The review pack justifies ${name} (${group}) and the code no longer asks for it`);
    if (!sameSet(asked, code.contract[group] ?? [])) problems.push(`The ${group} permissions the adapter asks for differ from META_PERMISSIONS in src/contracts/golive.js`);
  }
  for (const p of pack.permissions) {
    if (!['instagram', 'facebook', 'whatsapp'].includes(p.group)) problems.push(`${p.name}: group ${p.group} is not one the code has`);
    for (const field of ['usedFor', 'where', 'justification', 'screencast', 'login']) if (!String(p[field] ?? '').trim()) problems.push(`${p.name}: ${field} is empty`);
    if (chars(p.justification ?? '') > 1000) problems.push(`${p.name}: the justification is over 1000 characters, Meta's limit for the box`);
    if (!String(p.justification ?? '').includes(p.name)) problems.push(`${p.name}: the justification does not name the permission`);
  }
  // Every webhook field the code subscribes needs a permission the pack covers.
  for (const [field, scope] of Object.entries(code.webhookFieldScopes)) {
    if (!packNames.includes(scope)) problems.push(`Webhook field ${field} needs ${scope}, which the review pack does not cover`);
  }
  return problems;
}

export function screencastProblems(pack, root = ROOT) {
  const problems = [];
  const ids = pack.screencasts.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push('pack.json has two screencasts with one id');
  for (const p of pack.permissions) if (!ids.includes(p.screencast)) problems.push(`${p.name} names screencast ${p.screencast}, which has no script`);
  for (const s of pack.screencasts) {
    if (!pack.permissions.some((p) => p.screencast === s.id)) problems.push(`Screencast ${s.id} shows no permission`);
    if (!s.steps?.length) problems.push(`Screencast ${s.id} has no steps`);
    for (const [i, step] of (s.steps ?? []).entries()) {
      if (!String(step.tap ?? '').trim()) problems.push(`Screencast ${s.id}, step ${i + 1}: no tap`);
      if (!String(step.see ?? '').trim()) problems.push(`Screencast ${s.id}, step ${i + 1}: says nothing about what must be visible`);
    }
    if (s.rehearsal && !exists(root, s.rehearsal)) problems.push(`Screencast ${s.id}: the rehearsal ${s.rehearsal} does not exist`);
  }
  return problems;
}

// ---- claims, limits, secrets ----

/** What the company site's rules ban (PRD, USP rules): a promise of no bans, and "Meta-approved" before App Review and Tech Provider are done. */
export const BANNED_CLAIMS = Object.freeze([
  { name: 'Meta-approved', pattern: /\bmeta[\s-]+approved\b|\bapproved\s+by\s+meta\b|\bmeta[\s-]+certified\b|\bofficial\s+meta\s+(?:partner|tech\s+provider)\b/i },
  { name: 'a promise of no bans', pattern: /\bban[\s-]?proof\b|\bnever\s+(?:get\s+|be\s+|gets\s+)?(?:banned|restricted|shadow-?banned)\b|\bno\s+(?:more\s+)?(?:bans?|shadow-?bans?)\b|\b(?:guarantee[ds]?|promise[ds]?|ensure[ds]?)\b[^.\n]{0,60}\b(?:ban|banned|bans|shadow-?ban\w*)\b|\bsafe\s+from\s+(?:bans?|restrictions?)\b|\b100\s*%\s+safe\b|\bzero\s+(?:risk\s+of\s+)?bans?\b|\bwon'?t\s+(?:get\s+you\s+)?banned\b/i },
]);

export function claimProblems(texts) {
  const problems = [];
  for (const [file, text] of Object.entries(texts)) {
    for (const { name, pattern } of BANNED_CLAIMS) if (pattern.test(text)) problems.push(`${file} makes a claim the company site's rules ban: ${name}`);
  }
  return problems;
}

/** Google Play's and the App Store's limits, in characters (keywords: bytes). The owner app's check holds the same numbers. */
export const STORE_LIMITS = Object.freeze({
  play: { title: 30, shortDescription: 80, fullDescription: 4000 },
  appStore: { name: 30, subtitle: 30, promotionalText: 170, description: 4000, keywords: 100 },
});

export function limitProblems(listing, label) {
  const problems = [];
  for (const [store, limits] of Object.entries(STORE_LIMITS)) {
    for (const [field, max] of Object.entries(limits)) {
      const value = listing?.[store]?.[field];
      if (typeof value !== 'string' || !value.trim()) problems.push(`${label}: ${store}.${field} is empty`);
      else if ((field === 'keywords' ? Buffer.byteLength(value) : chars(value)) > max) problems.push(`${label}: ${store}.${field} is longer than ${max}`);
    }
  }
  return problems;
}

/** The template with a business's name filled in. The longest name a brand file allows is 30 characters. */
export function fillTemplate(template, brandName, shortName = brandName.slice(0, 12)) {
  const fill = (v) => (typeof v === 'string' ? v.replaceAll('{{brand_name}}', brandName).replaceAll('{{shop_name_short}}', shortName) : v);
  const out = JSON.parse(JSON.stringify(template));
  for (const store of ['play', 'appStore']) for (const key of Object.keys(out[store])) out[store][key] = fill(out[store][key]);
  out.reviewNotes = fill(out.reviewNotes);
  return out;
}
export const LONGEST_BRAND_NAME = 'W'.repeat(30);

const SECRET_PATTERNS = Object.freeze([
  ['an access token', /\b(?:EAA|IGAA|IGQ)[A-Za-z0-9]{20,}/],
  ['a payment key', /\b(?:rzp|sk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a database address with a login', /\b(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^\s/]*:[^\s/]*@/i],
  ['a cloud key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['a long hex or base64 secret', /\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/])/],
  ['a real Instagram account id', /\b17841\d{10,13}\b/],
  ['a mobile number', /(?<![\d.])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])/],
  ['a server address', /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b|10\.0\.0\.\d+\b)(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['an email address', /\b[\w.+-]+@(?!example\.(?:com|org|net)\b)[\w-]+(?:\.[\w-]+)+/],
  ['a Google or Apple client id', /\b\d{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/],
]);

export function secretProblems(texts) {
  const problems = [];
  for (const [file, text] of Object.entries(texts)) {
    for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) problems.push(`${file} holds ${name}`);
  }
  return problems;
}

// ---- generated documents ----

const bullet = (items) => items.map((i) => `- ${i}`).join('\n');
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const GENERATED = (source) => `<!-- Written from ${source} by node tools/review-pack/index.mjs --write. Edit the source, not this file. -->\n\n`;

export function renderPermissionsMd(pack, code) {
  const out = [`${GENERATED('docs/go-live/meta-app-review/pack.json and the code')}# Permissions the code asks for\n`];
  out.push('Every permission below is one the code asks for today (the Instagram and Facebook scope lists in src/adapters/meta/login.js, the WhatsApp ones in src/contracts/golive.js). `node tools/review-pack/index.mjs` fails if one is missing here or one here is no longer asked for. Request Advanced Access for each, and nothing else.\n');
  for (const [group, title] of [['instagram', 'Instagram Login'], ['facebook', 'Facebook Login for Business'], ['whatsapp', 'WhatsApp Business Platform']]) {
    out.push(`## ${title}\n`);
    for (const p of pack.permissions.filter((x) => x.group === group)) {
      out.push(`### ${p.name}\n`, `- **Used for:** ${p.usedFor}`, `- **Where in the product:** ${p.where}`, `- **Screencast:** ${p.screencast} (screencast-scripts.md)`, '', '**Justification text for the submission box:**\n', `> ${p.justification}\n`);
    }
  }
  out.push('## Webhook fields\n', 'The webhook fields the code subscribes to, and the permission each needs (src/modules/ig-connect/rules.js):\n', '| Field | Permission |', '| --- | --- |');
  for (const [field, scope] of Object.entries(code.webhookFieldScopes)) out.push(`| ${field} | ${scope} |`);
  out.push('');
  return out.join('\n');
}

export function renderScreencastsMd(pack) {
  const out = [`${GENERATED('docs/go-live/meta-app-review/pack.json')}# Screencast scripts\n`];
  out.push('One recording per script. Record on a phone, in the real app, with the real tester accounts. Say nothing that is not in the script; show each tap, and hold on each "must be visible" line for two seconds. The rehearsal named under a script is a Playwright flow that walks it against the simulators and saves a video: run it first, watch the video, then record the real one.\n');
  out.push('Rehearse: `npx playwright test e2e/p9/screencasts --project=phone` (videos land in test-results; nothing leaves this machine).\n');
  for (const s of pack.screencasts) {
    out.push(`## ${s.id}: ${s.title}\n`, `Permissions shown: ${pack.permissions.filter((p) => p.screencast === s.id).map((p) => `\`${p.name}\``).join(', ')}`, '', `Start: ${s.start}`, '', `Rehearsal: ${s.rehearsal ? `\`${s.rehearsal}\`` : 'none (needs a real tester account; the script is walked on the real app)'}`, '', '| # | Tap | Must be visible |', '| --- | --- | --- |');
    s.steps.forEach((step, i) => out.push(`| ${i + 1} | ${cell(step.tap)} | ${cell(step.see)} |`));
    out.push('');
  }
  return out.join('\n');
}

function listingSection(title, store, listing) {
  const out = [`## ${title}\n`];
  for (const [field, value] of Object.entries(store)) {
    if (field === 'category' || field.endsWith('Category')) { out.push(`**${field}:** ${value}\n`); continue; }
    const max = (listing === 'play' ? STORE_LIMITS.play : STORE_LIMITS.appStore)[field];
    const size = field === 'keywords' ? Buffer.byteLength(value) : chars(value);
    out.push(`### ${field}${max ? ` (${size} of ${max})` : ''}\n`, '```text', value, '```\n');
  }
  return out;
}

export function renderListingMd(root = ROOT) {
  const l = readJson(root, 'apps/owner/store/listing.json');
  const out = [`${GENERATED('apps/owner/store/listing.json')}# Bhava for Business: store listing text\n`, 'The one listing for both stores. The text, the limits and the permission sentences are kept in sync with the app by `node apps/owner/store/check.mjs`. Developer name, contact email and the privacy policy address are typed into each console, never kept here.\n'];
  out.push(...listingSection('Google Play', l.play, 'play'), ...listingSection('App Store', l.appStore, 'appStore'));
  out.push('## Permission sentences\n', '| Permission | Sentence shown to the person |', '| --- | --- |');
  for (const [group, entries] of Object.entries(l.permissions)) {
    if (typeof entries === 'string') out.push(`| ${group} | ${cell(entries)} |`);
    else for (const [name, sentence] of Object.entries(entries)) out.push(`| ${group === 'android' ? name : `${group}.${name}`} | ${cell(sentence)} |`);
  }
  out.push('');
  return out.join('\n');
}

export function renderDataSafetyMd(root = ROOT, answers) {
  const d = answers.dataSafety();
  const out = [`${GENERATED('apps/owner/store/collection.json (answers.cjs)')}# Google Play data safety: Bhava for Business\n`, 'Enter in Play Console, App content, Data safety. Worked out from what the app collects; do not edit by hand.\n'];
  out.push(`- Collects or shares data: ${d.collectsOrShares ? 'yes' : 'no'}`, `- Encrypted in transit: ${d.encryptedInTransit ? 'yes' : 'no'}`, `- Users can ask for deletion: ${d.deletionRequest.available ? `yes (${d.deletionRequest.how})` : 'no'}`, '', '| Category | Type | Collected | Shared | Required | Purposes | From |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const t of d.dataTypes) out.push(`| ${t.category} | ${t.type} | ${t.collected ? 'yes' : 'no'} | ${t.shared ? 'yes' : 'no'} | ${t.required ? 'yes' : 'optional'} | ${cell(t.purposes.join(', '))} | ${cell(t.from.join(', '))} |`);
  out.push('');
  return out.join('\n');
}

export function renderApplePrivacyMd(root = ROOT, answers) {
  const a = answers.appPrivacy();
  const out = [`${GENERATED('apps/owner/store/collection.json (answers.cjs)')}# Apple privacy label: Bhava for Business\n`, 'Enter in App Store Connect, App Privacy. Worked out from what the app collects; do not edit by hand.\n'];
  out.push(`- Collects data: ${a.collectsData ? 'yes' : 'no'}`, `- Used for tracking: ${a.tracking ? 'yes' : 'no'}`, '', '| Category | Type | Linked to the person | Used for tracking | Purposes | From |', '| --- | --- | --- | --- | --- | --- |');
  for (const t of a.dataTypes) out.push(`| ${t.category} | ${t.type} | ${t.linkedToUser ? 'yes' : 'no'} | ${t.usedForTracking ? 'yes' : 'no'} | ${cell(t.purposes.join(', '))} | ${cell(t.from.join(', '))} |`);
  out.push('');
  return out.join('\n');
}

const PURPOSE_WORDS = Object.freeze({ app_functionality: ['App functionality', 'App Functionality'] });

export function renderBrandedMd(template, dataCollected) {
  const out = [`${GENERATED('docs/go-live/store/branded-app-template.json and DATA_COLLECTED in src/contracts/apps.js')}# A seller's branded app: listing, data safety and privacy label\n`];
  out.push('The same template for every business. `{{brand_name}}` is the business\'s own name (30 characters at most). Nothing here names the platform: buyers see the seller\'s brand only.\n');
  const longest = fillTemplate(template, LONGEST_BRAND_NAME);
  out.push(...listingSection('Google Play (template)', template.play, 'play'), ...listingSection('App Store (template)', template.appStore, 'appStore'));
  out.push('Limits are checked with a 30 character name filled in.\n');
  out.push('## Permission sentences\n', '| Permission | Sentence shown to the person |', '| --- | --- |');
  for (const [name, sentence] of Object.entries(template.permissions)) out.push(`| ${name} | ${cell(sentence)} |`);
  out.push('', '## Data safety (Google Play) and privacy label (Apple)\n', 'No tracking. Nothing is shared with a third party for its own use. Deletion of the account is in the app.\n', '| Data | Play category and type | Apple category and type | Required | Purposes | Linked to the person |', '| --- | --- | --- | --- | --- | --- |');
  for (const d of dataCollected) {
    const m = template.collected[d.type];
    out.push(`| ${d.type} | ${m.play.category}: ${m.play.type} | ${m.apple.category}: ${m.apple.type} | ${d.optional ? 'optional' : 'required'} | ${d.purposes.map((p) => PURPOSE_WORDS[p]?.[0] ?? p).join(', ')} | ${d.linked ? 'yes' : 'no'} |`);
  }
  out.push('', '## Age rating\n', `- Google Play: ${template.ageRating.play}`, `- App Store: ${template.ageRating.apple}`, '', '## Review notes\n', '```text', longest.reviewNotes.replaceAll(LONGEST_BRAND_NAME, '{{brand_name}}'), '```', '');
  return out.join('\n');
}

export function renderCollectedMd(root, answers, dataCollected, packageText) {
  const c = answers.collection;
  const out = [`${GENERATED('apps/owner/store/collection.json and DATA_COLLECTED in src/contracts/apps.js')}# What each surface collects, and why\n`];
  out.push('## Bhava for Business (the seller app)\n', c.note, '', '| Data | Why | Required | Tracking |', '| --- | --- | --- | --- |');
  for (const i of c.items) out.push(`| ${cell(i.what)} | ${cell(i.why)} | ${i.required ? 'yes' : 'no'} | ${i.tracking ? 'yes' : 'no'} |`);
  out.push('', '## A seller\'s branded shopper app\n', 'Nothing is used for tracking or advertising. Payment details are the gateway\'s and are never held by the app.\n', '| Data | Why | Required |', '| --- | --- | --- |');
  const why = { name: 'Address labels and order messages', phone: 'Signing in and delivery contact', email: 'Receipts and sign-in with Google or Apple', address: 'Delivery', purchase_history: 'Showing and tracking orders, returns and reviews', device_id: 'Delivering notifications the person chose' };
  for (const d of dataCollected) out.push(`| ${d.type} | ${why[d.type] ?? 'App functionality'} | ${d.optional ? 'no' : 'yes'} |`);
  out.push('', '## The web console and storefronts\n', 'The console holds what the business writes (products, orders, replies) and the conversations of its own customers. A storefront holds the shopper\'s details for fulfilment, and measures visits only after the shopper accepts "Analytics and ads" in the business\'s consent banner.', '', '## The platform\n', 'Compliance log lines hold a hashed subject and a reason code, never a username or message text. Logs never hold personal data.', '');
  return out.join('\n');
}

/** Every generated document, as { path: text }. `answers` is apps/owner/store/answers.cjs. */
export async function generatedFiles(root = ROOT) {
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(root, 'tools/review-pack/lib.mjs'));
  const answers = req(path.join(root, 'apps/owner/store/answers.cjs'));
  const url = new URL(`file:///${path.join(root, 'src/contracts/apps.js').replace(/\\/g, '/')}`).href;
  const { DATA_COLLECTED } = await import(url);
  const pack = loadPack(root);
  const code = await codePermissions(root);
  const template = readJson(root, `${PACK}/store/branded-app-template.json`);
  return {
    [`${PACK}/meta-app-review/permissions.md`]: renderPermissionsMd(pack, code),
    [`${PACK}/meta-app-review/screencast-scripts.md`]: renderScreencastsMd(pack),
    [`${PACK}/store/listing-text.md`]: renderListingMd(root),
    [`${PACK}/store/play-data-safety.md`]: renderDataSafetyMd(root, answers),
    [`${PACK}/store/apple-privacy-label.md`]: renderApplePrivacyMd(root, answers),
    [`${PACK}/store/branded-app.md`]: renderBrandedMd(template, DATA_COLLECTED),
    [`${PACK}/privacy/collected-data.md`]: renderCollectedMd(root, answers, DATA_COLLECTED),
  };
}

export async function renderedProblems(root = ROOT, files = null) {
  const problems = [];
  const made = files ?? (await generatedFiles(root));
  for (const [rel, text] of Object.entries(made)) {
    if (!exists(root, rel)) problems.push(`${rel} is missing: run node tools/review-pack/index.mjs --write`);
    else if (norm(read(root, rel)) !== norm(text)) problems.push(`${rel} is not what its sources give: run node tools/review-pack/index.mjs --write`);
  }
  return problems;
}

export async function writeGenerated(root = ROOT) {
  const made = await generatedFiles(root);
  for (const [rel, text] of Object.entries(made)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return Object.keys(made);
}

// ---- store ----

/** Reads the shopper app's permissions out of its config text (the config needs a brand file to run). */
export function shopperAsked(root = ROOT) {
  const text = read(root, 'apps/shopper/app.config.js');
  const asked = new Set([...text.matchAll(/'(android\.permission\.[A-Z_]+)'/g)].filter((m) => {
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
    return /^\s*permissions:/.test(line);
  }).map((m) => m[1]));
  for (const m of text.matchAll(/^\s*(NS\w+UsageDescription):/gm)) asked.add(m[1]);
  const sentence = (name) => text.match(new RegExp(`const ${name} = '([^']*)'`))?.[1] ?? '';
  return { asked, camera: sentence('CAMERA'), photos: sentence('PHOTOS'), tracking: /NSPrivacyTracking:\s*false/.test(text) };
}

export async function storeProblems(root = ROOT, { template: given = null } = {}) {
  const problems = [];
  const url = (rel) => new URL(`file:///${path.join(root, rel).replace(/\\/g, '/')}`).href;
  // The owner app: its own check covers permissions, limits, collection sources, the manifest and the committed answers.
  const store = await import(url('apps/owner/store/check.mjs'));
  problems.push(...store.checkStore(root).map((p) => `owner app store check: ${p}`));

  const template = given ?? readJson(root, `${PACK}/store/branded-app-template.json`);
  problems.push(...limitProblems(fillTemplate(template, LONGEST_BRAND_NAME), 'branded-app-template.json with a 30 character name'));
  problems.push(...limitProblems(fillTemplate(template, 'A'), 'branded-app-template.json with a 1 character name'));
  const { namesPlatform, DATA_COLLECTED } = await import(url('src/contracts/apps.js'));
  for (const [where, text] of Object.entries({ ...template.play, ...template.appStore, reviewNotes: template.reviewNotes, ...template.permissions })) {
    if (namesPlatform(text)) problems.push(`branded-app-template.json: ${where} names the platform; buyers see the seller's brand only`);
  }
  const shopper = shopperAsked(root);
  const listed = new Set(Object.keys(template.permissions));
  for (const name of shopper.asked) if (!listed.has(name)) problems.push(`The shopper app asks for ${name} and branded-app-template.json does not explain it`);
  for (const name of listed) if (!shopper.asked.has(name)) problems.push(`branded-app-template.json explains ${name}, which the shopper app no longer asks for`);
  if (template.permissions.NSCameraUsageDescription !== shopper.camera) problems.push('The camera sentence in branded-app-template.json is not the one in the shopper app config');
  if (template.permissions.NSPhotoLibraryUsageDescription !== shopper.photos) problems.push('The photo sentence in branded-app-template.json is not the one in the shopper app config');
  if (!shopper.tracking) problems.push('The shopper app config no longer declares NSPrivacyTracking false');
  for (const d of DATA_COLLECTED) {
    if (!template.collected[d.type]) problems.push(`The shopper app collects ${d.type} (DATA_COLLECTED) and branded-app-template.json has no store answer for it`);
    if (d.tracking) problems.push(`DATA_COLLECTED says ${d.type} is used for tracking; the branded app's answers say no tracking`);
  }
  for (const type of Object.keys(template.collected)) if (!DATA_COLLECTED.some((d) => d.type === type)) problems.push(`branded-app-template.json answers for ${type}, which the shopper app no longer collects`);
  return problems;
}

// ---- privacy ----

const ADAPTER_NAMES = Object.freeze({ meta: 'Meta', facebook: 'Meta', whatsapp: 'WhatsApp', razorpay: 'Razorpay', shiprocket: 'Shiprocket', shopify: 'Shopify', google: 'Google', apple: 'Apple', push: 'Firebase Cloud Messaging', email: 'Email provider', ai: 'AI provider', eas: 'Expo' });
const NOT_PROCESSORS = new Set(['appstores']);

export async function privacyProblems(root = ROOT) {
  const problems = [];
  const url = (rel) => new URL(`file:///${path.join(root, rel).replace(/\\/g, '/')}`).href;
  const provider = await import(url('src/contracts/api/provider.js'));
  const store = await import(url('src/contracts/api/store.js'));
  const gates = await import(url('src/modules/ig-connect/gates.js'));
  const pages = readJson(root, `${PACK}/privacy/public-pages.json`).pages;
  const known = new Set([...Object.values(provider.PROVIDER_PATHS)]);
  for (const p of pages) {
    if (p.kind === 'platform' && p.path === '/privacy' && p.path !== gates.PRIVACY_PATH) problems.push(`public-pages.json: the privacy path is not ${gates.PRIVACY_PATH}`);
    if (p.kind === 'platform' && p.path.startsWith('/meta/') && !known.has(p.path)) problems.push(`public-pages.json: ${p.path} is not a provider callback in the code`);
    if (p.kind === 'business') {
      const kind = p.path.replace('/policies/', '');
      if (!store.POLICY_KINDS.includes(kind)) problems.push(`public-pages.json: ${p.path} is not a policy page the storefront serves`);
    }
  }
  for (const [name, route] of Object.entries({ deauthorize: provider.PROVIDER_PATHS.deauthorize, deletion: provider.PROVIDER_PATHS.deletion, 'deletion-status': provider.PROVIDER_PATHS.deletionStatus })) {
    if (!pages.some((p) => p.id === name && p.path === route)) problems.push(`public-pages.json does not list the ${name} address ${route}`);
  }
  if (!pages.some((p) => p.path === gates.PRIVACY_PATH)) problems.push('public-pages.json does not list the privacy page');
  for (const kind of store.POLICY_KINDS) if (!pages.some((p) => p.path === `/policies/${kind}`)) problems.push(`public-pages.json does not list /policies/${kind}`);
  for (const file of ['retention.md', 'dpdp.md', 'processors.md']) if (!exists(root, `${PACK}/privacy/${file}`)) problems.push(`privacy/${file} is missing`);

  // Every outside service the code has an adapter for is a processor the document names.
  if (exists(root, `${PACK}/privacy/processors.md`)) {
    const processors = read(root, `${PACK}/privacy/processors.md`).toLowerCase();
    for (const dir of fs.readdirSync(path.join(root, 'src/adapters'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      if (NOT_PROCESSORS.has(dir)) continue;
      if (!ADAPTER_NAMES[dir]) problems.push(`src/adapters/${dir} is new: name it in tools/review-pack/lib.mjs and in privacy/processors.md`);
      else if (!processors.includes(ADAPTER_NAMES[dir].toLowerCase())) problems.push(`privacy/processors.md does not name ${ADAPTER_NAMES[dir]} (src/adapters/${dir})`);
    }
  }
  // Retention periods stated must be the PRD's: the compliance log is purged after 13 months.
  if (exists(root, `${PACK}/privacy/retention.md`) && !/13 months/.test(read(root, `${PACK}/privacy/retention.md`))) problems.push('privacy/retention.md does not state the 13 month compliance log retention');
  return problems;
}

// ---- the narrative documents ----

export async function docProblems(root = ROOT) {
  const problems = [];
  const url = (rel) => new URL(`file:///${path.join(root, rel).replace(/\\/g, '/')}`).href;
  const required = ['README.md', 'meta-app-review/reviewer-steps.md', 'meta-app-review/data-handling.md', 'meta-app-review/release-gates.md', 'meta-app-review/submission-checklist.md', 'store/screenshots.md', 'store/age-rating.md', 'store/review-notes.md', 'cutover/runbook.md'];
  for (const rel of required) if (!exists(root, `${PACK}/${rel}`)) problems.push(`${PACK}/${rel} is missing`);
  if (problems.length) return problems;
  const doc = (rel) => read(root, `${PACK}/${rel}`);
  const provider = await import(url('src/contracts/api/provider.js'));
  const compliance = await import(url('src/contracts/compliance.js'));
  const gates = await import(url('src/modules/ig-connect/gates.js'));
  const pack = loadPack(root);

  if (pack.submitted !== false) problems.push('pack.json says the pack was submitted; nothing here is submitted to anyone');
  if (!/nothing[^.]*has been submitted/i.test(doc('README.md'))) problems.push('README.md no longer says nothing has been submitted');

  const handling = doc('meta-app-review/data-handling.md');
  for (const p of [provider.PROVIDER_PATHS.deauthorize, provider.PROVIDER_PATHS.deletion, provider.PROVIDER_PATHS.deletionStatus, gates.PRIVACY_PATH]) {
    if (!handling.includes(p)) problems.push(`data-handling.md does not give the address ${p}`);
  }
  const gateDoc = doc('meta-app-review/release-gates.md');
  for (const code of compliance.REASON_CODE_FAMILIES.gate) if (!gateDoc.includes(code)) problems.push(`release-gates.md does not explain ${code}`);
  for (const g of pack.gates ?? []) if (!gateDoc.includes(g.code)) problems.push(`release-gates.md does not explain ${g.code}`);
  if (!/reviewer-steps/.test(doc('meta-app-review/submission-checklist.md')) || !/screencast/i.test(doc('meta-app-review/submission-checklist.md'))) problems.push('submission-checklist.md does not cover the reviewer steps and the screencasts');
  const steps = doc('meta-app-review/reviewer-steps.md');
  if (!steps.includes('/review')) problems.push('reviewer-steps.md does not give the review sign-in path /review');
  if (!/demo business/i.test(steps)) problems.push('reviewer-steps.md does not name the demo business');

  const runbook = doc('cutover/runbook.md');
  const migrate = await import(url('scripts/migrate-business.js'));
  for (const word of ['Dry run', 'Freeze', 'Import', 'Checks', 'webhooks', 'DNS', 'Going back', 'R-05', 'R-06', 'R-07']) if (!new RegExp(word, 'i').test(runbook)) problems.push(`cutover/runbook.md has no part on ${word}`);
  for (const flag of ['--source', '--tenant', '--run', '--reels', '--reason']) if (!runbook.includes(flag)) problems.push(`cutover/runbook.md does not use the importer's ${flag}`);
  try { migrate.parseArgs(['--source', 'x', '--tenant', 'y', '--run', '--reels', 'drop', '--reason', 'z']); } catch (e) { problems.push(`The importer no longer accepts the arguments the runbook gives: ${e.message}`); }
  return problems;
}

/** Every document the pack holds, as { path: text }, for the claim and secret scans. Store text is added from the owner app. */
export function allTexts(root = ROOT) {
  const out = {};
  for (const rel of filesUnder(root, PACK)) if (/\.(md|json)$/.test(rel)) out[rel] = read(root, rel);
  out['apps/owner/store/listing.json'] = read(root, 'apps/owner/store/listing.json');
  return out;
}

export async function checkPack(root = ROOT) {
  const pack = loadPack(root);
  const code = await codePermissions(root);
  const texts = allTexts(root);
  return [
    ...permissionProblems(pack, code),
    ...screencastProblems(pack, root),
    ...claimProblems(texts),
    ...secretProblems(Object.fromEntries(Object.entries(texts).filter(([f]) => f.startsWith(PACK)))),
    ...limitProblems(readJson(root, 'apps/owner/store/listing.json'), 'apps/owner/store/listing.json'),
    ...(await storeProblems(root)),
    ...(await privacyProblems(root)),
    ...(await docProblems(root)),
    ...(await renderedProblems(root)),
  ];
}
