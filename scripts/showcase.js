// Loads the sample businesses of the showcase from their seed files (Phase 8, Q-01 to Q-04).
//
//   npm run showcase -- --check                       read and check every seed file; writes nothing, needs no database
//   npm run showcase                                  load every business of the manifest, then thirty days of activity
//   npm run showcase -- --plant-seed ../x/demo.json   products of a `from: 'setting'` business from a file outside the repository
//   npm run showcase -- --only first                  one business, by its key in the manifest
//   npm run showcase -- --no-activity                 the seed files only
//   npm run showcase -- --export-brands <folder>      after loading: one brand file per business, for `npm run build-brand`
//
// The outside file is read where it is: it is never copied into the repository, which is public. With no --plant-seed
// and no SHOWCASE_PLANT_SEED the committed fallback catalogue is used, so CI needs no sibling folder.
//
// Which businesses exist is data (the manifest); nothing here or in any tool names one. The contract is
// src/contracts/seed.js. Reading and checking (loadShowcase) is built; loading into the database (seedShowcase) is the
// seed track's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SHOWCASE, SeedCatalogue, ShowcaseManifest, ShowcaseSeed, danglingReferences, fromLegacyCatalogue,
} from '../src/contracts/seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ShowcaseError extends Error {}

const readJson = (file, what) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ShowcaseError(`${what} cannot be read: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ShowcaseError(`${what} is not valid JSON: ${file} (${err.message})`);
  }
};

const parsed = (schema, data, what) => {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ShowcaseError(`${what}: ${issue.path.join('.') || 'file'}: ${issue.message}`);
};

function readCatalogue(file, format, what) {
  const data = readJson(file, what);
  if (format === 'bhava') return parsed(SeedCatalogue, data, what);
  try {
    return fromLegacyCatalogue(data);
  } catch (err) {
    const issue = err?.issues?.[0];
    if (!issue) throw err;
    throw new ShowcaseError(`${what}: ${issue.path.join('.') || 'file'}: ${issue.message}`);
  }
}

/**
 * Reads the manifest and every seed file it names, resolves each business's products, and checks all of it. Nothing is
 * written and no database is opened. Answers
 *
 *   [{ key, file, seed, catalogue, productsFrom }]
 *
 * `seed` is a parsed ShowcaseSeed, `catalogue` a parsed SeedCatalogue, `productsFrom` is 'file', 'setting' or 'fallback'.
 * Throws ShowcaseError naming the file and the field for the first thing that is wrong: a file that does not fit its
 * schema, a person who is not invented, a reel that points at a product the catalogue does not have, or two businesses
 * sharing a slug, an Instagram id, an owner's phone, an app package or a link scheme.
 *
 * `plantSeed` is the outside catalogue (the --plant-seed flag); when empty, env[SHOWCASE.plantSetting]; when that is
 * empty too, the seed's committed fallback.
 */
export function loadShowcase({ root = ROOT, manifest = SHOWCASE.manifest, plantSeed = '', env = process.env, only = '' } = {}) {
  const manifestFile = path.resolve(root, manifest);
  const dir = path.dirname(manifestFile);
  const list = parsed(ShowcaseManifest, readJson(manifestFile, 'The manifest'), 'The manifest').businesses;
  if (only && !list.some((entry) => entry.key === only)) throw new ShowcaseError(`The manifest has no business with the key "${only}"`);
  const outside = plantSeed || env[SHOWCASE.plantSetting] || '';

  const loaded = list.map(({ key, file }) => {
    const seedFile = path.join(dir, file);
    const what = `Seed "${key}"`;
    const seed = parsed(ShowcaseSeed, readJson(seedFile, what), what);
    const source = seed.products;
    let catalogue;
    let productsFrom = source.from;
    if (source.from === 'file') catalogue = readCatalogue(path.resolve(dir, source.file), source.format, `${what} products`);
    else if (outside) catalogue = readCatalogue(path.resolve(outside), source.format, `${what} products (the outside catalogue)`);
    else {
      productsFrom = 'fallback';
      catalogue = readCatalogue(path.resolve(dir, source.fallback.file), source.fallback.format, `${what} products (the fallback)`);
    }
    const names = catalogue.products.map((product) => product.name);
    if (new Set(names).size !== names.length) throw new ShowcaseError(`${what} products: two products share a name`);
    const dangling = danglingReferences(seed, catalogue);
    if (dangling.length) throw new ShowcaseError(`${what}: ${dangling[0].path} names "${dangling[0].name}", which is not there (${dangling.length} in all)`);
    return { key, file, seed, catalogue, productsFrom };
  });

  // No two businesses may share what identifies one.
  const shared = [
    ['slug', (s) => s.business.slug], ['Instagram id', (s) => s.business.igUserId], ['Instagram name', (s) => s.business.igUsername],
    ['owner phone', (s) => s.business.owner.phone], ['Android package', (s) => s.app.androidPackage], ['link scheme', (s) => s.app.urlScheme],
  ];
  for (const [label, pick] of shared) {
    const values = loaded.map((entry) => pick(entry.seed));
    if (new Set(values).size !== values.length) throw new ShowcaseError(`Two businesses share the same ${label}`);
  }
  const media = loaded.flatMap((entry) => entry.seed.reels.map((reel) => reel.igMediaId));
  if (new Set(media).size !== media.length) throw new ShowcaseError('Two reels share the same made-up Instagram media id');

  return only ? loaded.filter((entry) => entry.key === only) : loaded;
}

/**
 * Loads what loadShowcase read into the database: for each business the tenant, its plan, owner, brand kit, app config,
 * made-up Instagram account, categories, products with options and variants, reels and landing pages in order,
 * automations (through the automations module's own save, so the compliance checks run), FAQ entries, coupons and store
 * settings. Everything inside withTenant for that business; nothing is copied from one business to another.
 *
 *   seedShowcase({ db, repos, ctx, businesses }) -> [{ key, tenantId, slug, created: { <kind>: n }, reused: { <kind>: n } }]
 *
 * Run twice, the second run creates nothing: every `created` is 0 (Q-01). The seed track builds it.
 */
export async function seedShowcase() {
  throw new ShowcaseError('Loading the seed files into the database is not built yet (Phase 8, seed track). Use --check to read and check them.');
}

export function parseArgs(argv, env = process.env) {
  const options = { check: false, plantSeed: env[SHOWCASE.plantSetting] || '', only: '', activity: true, exportBrands: '', days: SHOWCASE.days, randomSeed: SHOWCASE.randomSeed };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new ShowcaseError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === SHOWCASE.plantFlag) options.plantSeed = value(i++, arg);
    else if (arg === '--only') options.only = value(i++, arg);
    else if (arg === '--no-activity') options.activity = false;
    else if (arg === '--export-brands') options.exportBrands = value(i++, arg);
    else if (arg === '--days') options.days = Number(value(i++, arg));
    else if (arg === '--seed') options.randomSeed = Number(value(i++, arg));
    else throw new ShowcaseError(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(options.days) || options.days < 0 || options.days > 90) throw new ShowcaseError('--days is a whole number from 0 to 90');
  if (!Number.isInteger(options.randomSeed) || options.randomSeed < 0) throw new ShowcaseError('--seed is a whole number');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const businesses = loadShowcase({ plantSeed: options.plantSeed, only: options.only });
  for (const b of businesses) {
    console.log(`${b.key}: ${b.catalogue.products.length} products (${b.productsFrom}), ${b.catalogue.categories.length + b.seed.categories.length} categories, ${b.seed.reels.length} reels, ${b.seed.landingPages.length} pages, ${b.seed.automations.length} automations, ${b.seed.faq.length} FAQ entries, ${b.seed.coupons.length} coupons`);
  }
  if (options.check) {
    console.log('showcase: every seed file fits the contract and every person in them is invented.');
    return;
  }
  await seedShowcase({ businesses, options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`showcase: ${err.message}`);
    process.exit(err instanceof ShowcaseError ? 2 : 1);
  });
}
