// G-18, G-19 and G-20: the Meta App Review pack, the store listing and privacy material, and the cutover dry run. The pack
// and the listing are documents, so they are read as text and, for "kept honest by checks", the pack's own checker is run on
// a copy of the repository in which the code's permissions or a listing's length were changed. Attack cases: a permission
// added to the code, removed from it, a listing one character over each limit, a banned claim, a secret, a real phone number
// or address, the privacy answers against what the apps declare, and a dry run that writes anything.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { FACEBOOK_SCOPES, INSTAGRAM_SCOPES } from '../../../src/adapters/meta/login.js';
import { META_PERMISSIONS } from '../../../src/contracts/golive.js';
import { MigrateError, migrateBusiness, parseArgs, printReport } from '../../../scripts/migrate-business.js';
import { USERNAMES, legacyExport, world } from '../../p8/migration-import/support.js';
import { ROOT, assertNoneOf, dumpAll, exists, json, read, runNode, scratch } from './support.js';

const walk = (dir) => (exists(dir) ? fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/')) : []);
const textOf = (dir, re = /\.(md|json|ya?ml|txt)$/) => walk(dir).filter((f) => re.test(f)).map((f) => `\n<<${f}>>\n${read(f)}`).join('\n');
const ALL_PERMISSIONS = [...META_PERMISSIONS.instagram, ...META_PERMISSIONS.facebook, ...META_PERMISSIONS.whatsapp];
const PERMISSION_WORD = /\b(?:instagram_business|instagram_basic|instagram_manage|instagram_content|pages|whatsapp_business|business|ads|catalog|commerce|leads)_[a-z_]+\b/g;

// ---- G-18 ----------------------------------------------------------------------------------------------------------------

const PACK = 'docs/go-live/meta-app-review';

test('G-18: the permissions the contract lists are exactly the scopes the Meta adapter asks for', () => {
  assert.deepEqual([...META_PERMISSIONS.instagram], [...INSTAGRAM_SCOPES]);
  assert.deepEqual([...META_PERMISSIONS.facebook], [...FACEBOOK_SCOPES]);
});

test('G-18: the pack covers every permission the code asks for and no other, each with a justification, a screencast script and test steps', () => {
  const files = walk(PACK);
  assert.ok(files.length > 0, `no pack under ${PACK}`);
  const text = textOf(PACK);
  const missing = ALL_PERMISSIONS.filter((p) => !text.includes(p));
  assert.deepEqual(missing, [], 'permissions the code asks for that the pack does not cover');
  const named = new Set([...text.matchAll(PERMISSION_WORD)].map((m) => m[0]).filter((w) => /^(instagram_|pages_|whatsapp_business_)/.test(w)));
  assert.deepEqual([...named].filter((p) => !ALL_PERMISSIONS.includes(p)), [], 'a permission the pack justifies that the code does not ask for');
  for (const permission of ALL_PERMISSIONS) {
    const mentions = text.split(permission).length - 1;
    assert.ok(mentions >= 3, `${permission} is named ${mentions} time(s): use, justification and screencast/test step are each expected`);
  }
  for (const word of [/justif/i, /screencast/i, /test steps?|steps? to test|reviewer/i, /release gate|gate\./i, /deauthori[sz]e|deletion/i]) assert.match(text, word, String(word));
});

test('G-18: each permission has a section with its use, its justification, a screencast script and the reviewer\'s steps', () => {
  const files = walk(PACK).filter((f) => /\.md$/.test(f));
  assert.ok(files.length > 0, 'no pack');
  const sections = files.flatMap((f) => read(f).split(/^#{1,4}\s+/m).slice(1));
  for (const permission of ALL_PERMISSIONS) {
    const own = sections.filter((s) => s.split('\n')[0].includes(permission) || s.includes(`\`${permission}\``));
    assert.ok(own.length > 0, `${permission}: no section`);
    const body = own.join('\n');
    assert.match(body, /justif/i, `${permission}: a justification`);
    assert.match(body, /screencast|record|video/i, `${permission}: a screencast script`);
    assert.match(body, /\n\s*(\d+\.|[-*])\s+/, `${permission}: steps`);
    assert.ok(body.replace(/\s+/g, ' ').length > 200, `${permission}: more than a heading`);
  }
});

/** A copy of what the pack's checker reads, so the code can be changed without touching this repository. */
function cloneRepo() {
  const dest = scratch('bhava-p9-clone-');
  const keep = ['src', 'tools', 'scripts', 'docs', 'deploy', 'requirements', 'shared', 'apps', 'package.json', 'HANDOFF.md', 'README.md'];
  for (const name of keep) {
    if (!exists(name)) continue;
    fs.cpSync(path.join(ROOT, name), path.join(dest, name), { recursive: true, filter: (src) => !/node_modules|[\\/]\.git([\\/]|$)|[\\/]test-results/.test(src) });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
  return dest;
}
const checkerCommand = () => {
  const scripts = json('package.json').scripts ?? {};
  const named = Object.keys(scripts).find((k) => /review-pack/.test(k));
  if (named) return scripts[named].replace(/^node\s+/, '').split(/\s+/);
  return ['tools/review-pack/index.mjs'];
};
const runChecker = (cwd, args = []) => runNode([...checkerCommand(), ...args], { cwd, timeoutMs: 120_000 });
const editIn = (dir, file, fn) => {
  const p = path.join(dir, file);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
};

test('G-18: the pack\'s checker passes on the pack as it stands', async () => {
  assert.ok(exists(checkerCommand()[0]), `${checkerCommand()[0]} is not built`);
  const res = await runChecker(ROOT);
  assert.equal(res.code, 0, res.stdout + res.stderr);
});

test('G-18: a permission added to the code that the pack does not cover fails the checker and names it', async () => {
  assert.ok(exists(checkerCommand()[0]), 'the checker is not built');
  const dir = cloneRepo();
  editIn(dir, 'src/adapters/meta/login.js', (s) => s.replace("'instagram_business_basic'", "'instagram_business_basic', 'instagram_business_content_publish'"));
  const res = await runChecker(dir);
  assert.notEqual(res.code, 0, 'the added permission was not noticed');
  assert.match(res.stdout + res.stderr, /instagram_business_content_publish/);
});

test('G-18: a permission removed from the code that the pack still justifies fails the checker and names it', async () => {
  assert.ok(exists(checkerCommand()[0]), 'the checker is not built');
  const dir = cloneRepo();
  editIn(dir, 'src/adapters/meta/login.js', (s) => s.replace(/\s*'instagram_business_manage_insights',?/, ''));
  const res = await runChecker(dir);
  assert.notEqual(res.code, 0, 'the removed permission was not noticed');
  assert.match(res.stdout + res.stderr, /instagram_business_manage_insights/);
});

test('G-18: a pack section for a permission deleted from the documents fails the checker', async () => {
  assert.ok(exists(checkerCommand()[0]), 'the checker is not built');
  const dir = cloneRepo();
  for (const file of walk(`${PACK}`)) editIn(dir, file, (s) => s.split('pages_messaging').join('pages-removed'));
  const res = await runChecker(dir);
  assert.notEqual(res.code, 0);
  assert.match(res.stdout + res.stderr, /pages_messaging/);
});

// ---- G-19 ----------------------------------------------------------------------------------------------------------------

const STORE = 'docs/go-live/store';
const LIMITS = [
  { store: 'Play', field: 'Title', match: /^(play[^a-z]*)?(app )?title$/i, max: 30 },
  { store: 'Play', field: 'Short description', match: /^(play[^a-z]*)?short description$/i, max: 80 },
  { store: 'Play', field: 'Full description', match: /^(play[^a-z]*)?full description$/i, max: 4000 },
  { store: 'App Store', field: 'Name', match: /^(app store[^a-z]*)?(app )?name$/i, max: 30 },
  { store: 'App Store', field: 'Subtitle', match: /^subtitle$/i, max: 30 },
  { store: 'App Store', field: 'Promotional text', match: /^promotional text$/i, max: 170 },
  { store: 'App Store', field: 'Description', match: /^description$/i, max: 4000 },
  { store: 'App Store', field: 'Keywords', match: /^keywords$/i, max: 100 },
  { store: 'App Store', field: 'What\'s new', match: /^(what['’]?s new|release notes)$/i, max: 4000 },
];

/** The listing fields found in the store documents: `Label: value` lines, `## Label` sections, and JSON or YAML keys. */
function listingFields() {
  const found = [];
  for (const file of walk(STORE).filter((f) => /\.(md|json|ya?ml)$/.test(f))) {
    const text = read(file);
    const add = (label, value) => {
      const rule = LIMITS.find((l) => l.match.test(label.trim().replace(/[*_`]/g, '')));
      if (rule && value.trim()) found.push({ file, rule, label, value: value.trim() });
    };
    if (/\.md$/.test(file)) {
      for (const m of text.matchAll(/^(?:[-*]\s+)?\*{0,2}([A-Za-z' ’]+?)\*{0,2}\s*(?:\(\d+[^)]*\))?\s*:\s*\*{0,2}\s*(.+)$/gm)) add(m[1], m[2]);
      const parts = text.split(/^#{2,4}\s+/m).slice(1);
      for (const part of parts) {
        const [head, ...body] = part.split('\n');
        add(head.replace(/\s*\(.*\)\s*$/, ''), body.join('\n').replace(/^\s*```\w*\n?|\n?```\s*$/g, '').trim());
      }
    } else {
      const walkObj = (node, prefix = '') => {
        if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walkObj(v, k);
        else if (typeof node === 'string') add(prefix.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), node);
      };
      try {
        walkObj(/\.json$/.test(file) ? JSON.parse(text) : (await_yaml(text)));
      } catch {
        // A file that is not one of these shapes holds no fields this check can read.
      }
    }
  }
  return found;
}
test('G-19: the listing text is found for both stores and each field is within its store\'s limit', () => {
  const fields = listingFields();
  assert.ok(exists(STORE), `no ${STORE}`);
  assert.ok(fields.length >= 4, `only ${fields.length} listing fields found under ${STORE}`);
  const stores = new Set(fields.map((f) => f.rule.store));
  assert.ok(stores.has('Play') && stores.has('App Store'), 'a listing for each store');
  const over = fields.filter((f) => [...f.value].length > f.rule.max).map((f) => `${f.file}: ${f.rule.store} ${f.rule.field} is ${[...f.value].length}, limit ${f.rule.max}`);
  assert.deepEqual(over, []);
  for (const required of ['Short description', 'Subtitle', 'Promotional text']) assert.ok(fields.some((f) => f.rule.field === required), `${required} is missing`);
});

test('G-19: a listing field one character over its limit fails the checker, and one at the limit does not, for each field', async () => {
  assert.ok(exists(checkerCommand()[0]), 'the checker is not built');
  const fields = listingFields();
  assert.ok(fields.length > 0, 'no listing fields');
  const seen = new Set();
  const problems = [];
  const dir = cloneRepo();
  for (const f of fields) {
    const id = `${f.rule.store}/${f.rule.field}`;
    if (seen.has(id) || f.rule.max > 500) continue;
    seen.add(id);
    for (const [extra, mustPass] of [[0, true], [1, false]]) {
      const size = f.rule.max + extra;
      const value = 'a'.repeat(Math.max(0, size - 1)) + (extra ? 'b' : 'c');
      const original = fs.readFileSync(path.join(dir, f.file), 'utf8');
      editIn(dir, f.file, (s) => s.replace(f.value, value.slice(0, size)));
      const res = await runChecker(dir);
      fs.writeFileSync(path.join(dir, f.file), original);
      if (mustPass && res.code !== 0 && !new RegExp(id.split('/')[1], 'i').test(res.stdout + res.stderr)) continue;
      if (mustPass && res.code !== 0) problems.push(`${id}: ${size} characters is at the limit and was refused`);
      if (!mustPass && res.code === 0) problems.push(`${id}: ${size} characters is one over the limit and was accepted`);
      if (!mustPass && res.code !== 0 && !new RegExp(String(f.rule.max)).test(res.stdout + res.stderr)) problems.push(`${id}: the refusal does not name the limit ${f.rule.max}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('G-19: the listing and every go-live document make no promise the company site bans: no "no bans", no "Meta-approved"', () => {
  const text = textOf('docs/go-live') + textOf(STORE);
  assert.ok(text.length > 500, 'no go-live documents');
  const banned = [/meta[- ](approved|certified|endorsed|partner(ed)?)\b(?!\s+status)/i, /\b(no|zero|never|without any|avoid|prevent)s?\s+(risk of\s+)?(ban|bans|banned|banning|blocks?|suspension)/i, /ban[- ]?(proof|free|safe)/i, /\bguarantee[sd]?\b[^.\n]*\b(ban|block|reach|sales|followers|growth|income|revenue)/i, /official(ly)?\s+(instagram|meta|whatsapp)\b/i];
  const hits = [];
  for (const line of text.split('\n')) for (const re of banned) if (re.test(line) && !/\b(do not|don't|never claim|must not|banned claims?|not say)\b/i.test(line)) hits.push(line.trim().slice(0, 120));
  assert.deepEqual(hits, []);
});

test('G-19: the seller\'s branded-app listing template names the business and never the platform', () => {
  const candidates = walk(STORE).filter((f) => /(brand|seller|template)/i.test(f));
  assert.ok(candidates.length > 0, 'no seller listing template under the store documents');
  for (const file of candidates) {
    const text = read(file);
    assert.match(text, /\{\{?\s*(business|store|brand|app)[_ ]?name\s*\}?\}|\[(business|store|brand)[ _]name\]|<(business|store|brand)[ _]name>/i, `${file}: a place for the business name`);
    assert.doesNotMatch(text.replace(/^>.*$/gm, ''), /bhava/i, `${file}: names the platform`);
  }
});

function declaredByApps() {
  const out = { android: new Set(), ios: new Set() };
  for (const app of ['owner', 'shopper']) {
    const file = `apps/${app}/app.config.js`;
    if (!exists(file)) continue;
    const text = read(file);
    for (const m of text.matchAll(/android\.permission\.([A-Z_]+)/g)) out.android.add(m[1]);
    for (const m of text.matchAll(/\b(NS[A-Za-z]+UsageDescription)\b/g)) out.ios.add(m[1]);
  }
  return out;
}
const KEYWORD = {
  CAMERA: /camera/i, POST_NOTIFICATIONS: /notification|push/i, USE_BIOMETRIC: /biometric|fingerprint|face/i, ACCESS_FINE_LOCATION: /location/i, READ_CONTACTS: /contacts/i,
  RECORD_AUDIO: /microphone|audio/i, NSCameraUsageDescription: /camera/i, NSPhotoLibraryUsageDescription: /photo/i, NSFaceIDUsageDescription: /face ?id|biometric/i,
  NSLocationWhenInUseUsageDescription: /location/i, NSContactsUsageDescription: /contacts/i, NSMicrophoneUsageDescription: /microphone|audio/i,
};

test('G-19: the privacy answers cover every permission the apps declare, and claim no data the apps cannot collect', () => {
  const text = textOf(STORE) + textOf('docs/go-live/privacy');
  assert.ok(text.length > 500, 'no privacy answers under docs/go-live');
  const declared = declaredByApps();
  const missing = [...declared.android, ...declared.ios].filter((p) => KEYWORD[p] && !KEYWORD[p].test(text));
  assert.deepEqual(missing, [], 'declared by an app, not in the privacy answers');
  const everything = new Set([...declared.android, ...declared.ios]);
  const claims = [];
  for (const [perm, word] of [['ACCESS_FINE_LOCATION', /location/i], ['READ_CONTACTS', /contacts/i], ['RECORD_AUDIO', /microphone/i]]) {
    const has = [...everything].some((p) => p === perm || (KEYWORD[p] && KEYWORD[p] === KEYWORD[perm]));
    if (has) continue;
    for (const line of text.split('\n')) if (word.test(line) && /\b(collected|yes|we collect|collects)\b/i.test(line) && !/\b(not|no|never|doesn't|does not)\b/i.test(line)) claims.push(line.trim().slice(0, 120));
  }
  assert.deepEqual(claims, [], 'claims a kind of data no app is able to collect');
});

test('G-19: the owner and shopper apps\' privacy manifests declare what the privacy answers say', () => {
  for (const app of ['owner', 'shopper']) {
    const text = read(`apps/${app}/app.config.js`);
    assert.match(text, /privacyManifests?|NSPrivacyAccessedAPITypes/, `${app}: a privacy manifest`);
  }
  const answers = textOf(STORE) + textOf('docs/go-live/privacy');
  assert.match(answers, /NSPrivacyAccessedAPI|required[- ]reason|privacy manifest/i, 'the privacy material speaks of the manifest');
});

test('G-18: no go-live document holds a secret, a real person\'s number, an account id or a server address', () => {
  const dirs = ['docs/go-live', 'deploy/prod/runbooks', 'deploy/golive'];
  const problems = [];
  assert.ok(walk('docs/go-live').length > 0, 'no go-live documents to check');
  assert.ok(walk('deploy/prod/runbooks').filter((f) => !/README/.test(f)).length > 0, 'no runbooks to check');
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      const text = read(file);
      if (/AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|EAA[A-Za-z0-9]{40,}|rzp_(live|test)_[A-Za-z0-9]{10,}|sk_(live|test)_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}/.test(text)) problems.push(`${file}: a key`);
      if (/(?<![\d.])(?!127\.0\.0\.1|0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/.test(text.replace(/\b\d+\.\d+\.\d+\.\d+\.(?:test|example)/g, ''))) problems.push(`${file}: an address`);
      if (/(?<![\d.])(\+?91[- ]?)?[6-9]\d{9}(?![\d])/.test(text)) problems.push(`${file}: a phone number`);
      if (/(?<![\w.])[\w.+-]+@(?!example\.|.*\.example|.*\.test)[\w-]+\.[a-z]{2,}/i.test(text)) problems.push(`${file}: an email address`);
      if (/\b(act_\d{6,}|\d{15,17})\b/.test(text.replace(/<[^>]*>/g, ''))) problems.push(`${file}: an account id`);
    }
  }
  assert.deepEqual(problems, []);
});

// ---- G-20 ----------------------------------------------------------------------------------------------------------------

const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});

test('G-20: a cutover dry run of an old single-shop backup reports counts and writes nothing, in any table', async () => {
  const w = await world();
  closers.push(() => w.db.close?.());
  const source = await legacyExport();
  const before = await dumpAll(w.q);
  const lines = [];
  const report = await migrateBusiness({ db: w.db, platform: w.ctx.platform, source, options: parseArgs(['--source', 'old.json', '--tenant', 'importing']) });
  printReport(report, { run: false }, (line) => lines.push(line));
  const after = await dumpAll(w.q);
  assert.equal(report.mode, 'dry');
  assert.deepEqual(after.map(([name, text]) => [name, text.length]), before.map(([name, text]) => [name, text.length]));
  const changed = after.filter(([name, text], i) => text !== before[i][1]).map(([name]) => name);
  assert.deepEqual(changed, [], 'a dry run wrote to these tables');
  assert.match(lines.join('\n'), /Dry run: nothing was written/);
  assert.ok(Object.values(report.counts).some((c) => c.source > 0), 'it reports counts');
  assertNoneOf('the printed report', lines.join('\n'), [...USERNAMES, '9000000201', 'Rhea']);
});

test('G-20: the dry run says the same twice, a real run needs a reason, and the dry run is still the default', async () => {
  const w = await world();
  closers.push(() => w.db.close?.());
  const source = await legacyExport();
  const run = () => migrateBusiness({ db: w.db, platform: w.ctx.platform, source, options: parseArgs(['--source', 'old.json', '--tenant', 'importing']) });
  const first = await run();
  const second = await run();
  assert.deepEqual(first.counts, second.counts);
  assert.equal(parseArgs(['--source', 'x.json', '--tenant', 'importing']).run, false);
  await assert.rejects(migrateBusiness({ db: w.db, platform: w.ctx.platform, source, options: parseArgs(['--source', 'x.json', '--tenant', 'importing', '--run']) }), (e) => e instanceof MigrateError && /--reason/.test(e.message));
  const [{ n }] = await w.q('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [w.target.id]);
  assert.equal(n, 0, 'nothing was imported by the refused real run');
});

test('G-20: the cutover runbook exists, puts the dry run before the real run, and every command in it is one the importer accepts', () => {
  const file = 'deploy/prod/runbooks/cutover.md';
  assert.ok(exists(file), `${file} is not written`);
  const text = read(file);
  const lines = text.split('\n').filter((l) => /migrate-business/.test(l) && /--source/.test(l));
  assert.ok(lines.length >= 2, 'a dry run command and a real run command');
  const dry = lines.findIndex((l) => !/--run\b/.test(l));
  const real = lines.findIndex((l) => /--run\b/.test(l));
  assert.ok(dry !== -1 && real !== -1 && dry < real, 'the dry run comes first');
  for (const line of lines) {
    const args = line.replace(/^.*?migrate-business\s*(--\s*)?/, '').replace(/`/g, '').trim().split(/\s+/).map((a) => a.replace(/^<.*>$/, 'value').replace(/^"|"$/g, ''));
    assert.doesNotThrow(() => parseArgs(args.filter((a) => a !== '|')), `the importer rejects: ${line.trim()}`);
  }
  for (const word of [/freeze|stop (the )?(old|writes)|read[- ]only/i, /webhook/i, /DNS/i, /roll ?back|go back|back out/i, /count/i]) assert.match(text, word, String(word));
});
