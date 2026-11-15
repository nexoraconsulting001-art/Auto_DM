import { z } from 'zod';
import { ACCOUNT_TYPES } from './accounts.js';
import { PLANS } from './billing.js';

/**
 * The showcase seed (Phase 8, Q-01 to Q-04): what a sample business is loaded from, and the rules every invented person
 * follows. Data and pure rules only: no database, no file reads. The loader is scripts/showcase.js (`npm run showcase`).
 *
 * Which businesses are loaded is data, never code: the manifest (SHOWCASE.manifest) names each one's seed file by a neutral
 * key, and no file outside seed/ and docs/ names a sample business (tools/policy-check.mjs holds that line).
 *
 * A seed file is loaded the way a seller would have made it: through the repos and the store's own routes, inside
 * withTenant, never by copying rows between businesses. Loading twice changes nothing: every item has a natural key
 * (a slug, a name, a code, a made-up Instagram media id) that the loader matches on.
 */

/** Where things are, and the settings the loader reads. Paths are relative to the repository. */
export const SHOWCASE = Object.freeze({
  manifest: 'seed/showcase/manifest.json',
  /** A catalogue file outside the repository for a business whose products are `from: 'setting'`; never copied in. */
  plantSetting: 'SHOWCASE_PLANT_SEED',
  plantFlag: '--plant-seed',
  /** The activity generator's defaults (tools/sim/activity): two runs with the same seed agree. */
  days: 30,
  randomSeed: 80_808,
});

/**
 * Every person in the sample data is invented (Q-02). `problemsWithPerson` fails anything that is not:
 *   - a phone in the block this project reserves for sample people: +91 90000 0xxxx (10,000 numbers). The block is this
 *     contract's rule, not a regulator's: what keeps it harmless is that nothing in the showcase sends outside tools/sim.
 *   - a name made of one first name and one last name of the fixed lists below
 *   - an email on an example domain (RFC 2606), or on a host ending .example or .test
 *   - an Instagram id of 15 to 17 digits starting 9000 and a username starting demo_
 */
export const PEOPLE_RULES = Object.freeze({
  phone: Object.freeze({ prefix: '+91900000', pattern: /^\+91900000\d{4}$/, first: '+919000000000', last: '+919000009999' }),
  names: Object.freeze({
    first: Object.freeze(['Aarohi', 'Bhavik', 'Charvi', 'Devansh', 'Eshani', 'Falak', 'Gauri', 'Hriday', 'Ishani', 'Jivika', 'Kavish', 'Lavanya', 'Mihika', 'Nirav', 'Ojas', 'Pranavi', 'Reyansh', 'Saanvi', 'Tanay', 'Urvi', 'Vihaan', 'Yashvi', 'Zoya', 'Advik']),
    last: Object.freeze(['Ambekar', 'Bhandari', 'Chitale', 'Dalvi', 'Gokhale', 'Hegde', 'Inamdar', 'Jadhav', 'Karnik', 'Lokhande', 'Mhatre', 'Nadkarni', 'Oak', 'Pendse', 'Ranade', 'Sathe', 'Tambe', 'Ubale', 'Vaidya', 'Wagle']),
  }),
  emailDomains: Object.freeze(['example.com', 'example.org', 'example.net']),
  emailSuffixes: Object.freeze(['.example', '.test']),
  instagram: Object.freeze({ id: /^9000\d{11,13}$/, username: /^demo_[a-z0-9_]{3,24}$/ }),
});

const emailInvented = (email) => {
  const at = String(email).lastIndexOf('@');
  if (at < 1) return false;
  const host = String(email).slice(at + 1).toLowerCase();
  return PEOPLE_RULES.emailDomains.includes(host) || PEOPLE_RULES.emailSuffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
};

const nameInvented = (name) => {
  const parts = String(name).split(' ');
  return parts.length === 2 && PEOPLE_RULES.names.first.includes(parts[0]) && PEOPLE_RULES.names.last.includes(parts[1]);
};

/**
 * What is wrong with one person: [] when every field given is invented. `name` and `phone` are required; `email`,
 * `igUserId` and `igUsername` are checked when present. Each problem names the field only, never its value.
 */
export function problemsWithPerson(person) {
  const problems = [];
  if (!nameInvented(person?.name ?? '')) problems.push('name');
  if (!PEOPLE_RULES.phone.pattern.test(String(person?.phone ?? ''))) problems.push('phone');
  if (person?.email !== undefined && person.email !== '' && !emailInvented(person.email)) problems.push('email');
  if (person?.igUserId !== undefined && !PEOPLE_RULES.instagram.id.test(String(person.igUserId))) problems.push('igUserId');
  if (person?.igUsername !== undefined && !PEOPLE_RULES.instagram.username.test(String(person.igUsername))) problems.push('igUsername');
  return problems;
}

/** [{ index, fields }] for every person of a list that breaks a rule. Empty means all are invented. */
export const problemsWithPeople = (people) =>
  people.map((person, index) => ({ index, fields: problemsWithPerson(person) })).filter((found) => found.fields.length > 0);

/** The `n`th invented person (n from 0, below 480 for distinct names; phones repeat after 10,000): the same every time. */
export function inventedPerson(n) {
  const { first, last } = PEOPLE_RULES.names;
  const name = `${first[n % first.length]} ${last[Math.floor(n / first.length) % last.length]}`;
  const digits = String(n % 10_000).padStart(4, '0');
  return {
    name,
    phone: `${PEOPLE_RULES.phone.prefix}${digits}`,
    email: `${name.toLowerCase().replace(' ', '.')}.${digits}@example.com`,
    igUserId: `9000${String(1_000_000_000_00 + n)}`,
    igUsername: `demo_${name.toLowerCase().replace(' ', '_')}_${digits}`,
  };
}

// ---- The seed file ----

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
const Name = z.string().trim().min(1).max(120);
const Words = (max) => z.string().max(max).default('');
const Paise = z.number().int().nonnegative();
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Link = z.string().regex(/^https:\/\//).max(1000);
const MadeUpMediaId = z.string().regex(PEOPLE_RULES.instagram.id, 'Use a made-up Instagram media id: 15 to 17 digits starting 9000');

const Person = z.object({ name: z.string(), phone: z.string(), email: z.string().default('') })
  .refine((person) => problemsWithPerson(person).length === 0, 'The owner must be an invented person (PEOPLE_RULES)');

export const SeedCategory = z.strictObject({
  name: Name,
  slug: Slug,
  description: Words(500),
  imageUrl: z.union([Link, z.literal('')]).default(''),
  position: z.number().int().nonnegative().default(0),
});

/** An option is a named choice ("Size": S, M, L); a variant is one combination, with its own price and stock when given. */
export const SeedProduct = z.strictObject({
  name: Name,
  description: Words(5000),
  pricePaise: Paise,
  mrpPaise: Paise.nullable().default(null),
  images: z.array(Link).max(12).default([]),
  categories: z.array(Name).max(20).default([]),
  featured: z.boolean().default(false),
  stock: z.number().int().nonnegative().nullable().default(null),
  options: z.array(z.strictObject({ name: z.string().trim().min(1).max(40), values: z.array(z.string().trim().min(1).max(40)).min(1).max(30) })).max(3).default([]),
  variants: z.array(z.strictObject({
    options: z.record(z.string(), z.string()),
    pricePaise: Paise.optional(),
    mrpPaise: Paise.optional(),
    stock: z.number().int().nonnegative().nullable().default(null),
    sku: z.string().max(60).default(''),
  })).max(100).default([]),
}).superRefine((product, ctx) => {
  if (product.mrpPaise !== null && product.mrpPaise < product.pricePaise) ctx.addIssue({ code: 'custom', message: 'The MRP is below the price', path: ['mrpPaise'] });
  const allowed = new Map(product.options.map((option) => [option.name, option.values]));
  product.variants.forEach((variant, index) => {
    const names = Object.keys(variant.options);
    const fits = names.length === allowed.size && names.every((name) => allowed.get(name)?.includes(variant.options[name]));
    if (!fits) ctx.addIssue({ code: 'custom', message: 'A variant must pick one value of every option', path: ['variants', index] });
  });
});

/** A product catalogue in Bhava's own shape: what `products.file` and the fallback of `from: 'setting'` hold. */
export const SeedCatalogue = z.strictObject({
  schema: z.literal(1),
  note: Words(500),
  categories: z.array(SeedCategory).max(200).default([]),
  products: z.array(SeedProduct).min(1).max(2000),
});

/**
 * The old single-shop app's seed shape (seed files of format 'legacy'): prices in rupees, one option-less product per
 * row. Unknown keys pass through and are ignored, so a newer file of the same family still loads.
 */
export const LegacyCatalogue = z.looseObject({
  store: z.record(z.string(), z.unknown()).default({}),
  categories: z.array(z.looseObject({ name: Name, slug: Slug, image_url: z.string().default(''), description: z.string().default(''), position: z.number().int().default(0) })).default([]),
  products: z.array(z.looseObject({
    name: Name,
    price: z.number().nonnegative(),
    mrp: z.number().nonnegative().nullish(),
    description: z.string().default(''),
    images: z.array(z.string()).default([]),
    categories: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
  })).min(1),
});

const rupeesToPaise = (rupees) => Math.round(rupees * 100);
const httpsOnly = (links) => links.filter((link) => /^https:\/\//.test(link));

/** A legacy catalogue as a SeedCatalogue (parsed, so defaults are filled in). Throws a ZodError when the file does not fit. */
export function fromLegacyCatalogue(data) {
  const legacy = LegacyCatalogue.parse(data);
  return SeedCatalogue.parse({
    schema: 1,
    categories: legacy.categories.map((c) => ({ name: c.name, slug: c.slug, description: c.description.slice(0, 500), imageUrl: /^https:\/\//.test(c.image_url) ? c.image_url : '', position: Math.max(0, c.position) })),
    products: legacy.products.map((p) => {
      const pricePaise = rupeesToPaise(p.price);
      const mrpPaise = p.mrp ? rupeesToPaise(p.mrp) : null;
      return {
        name: p.name,
        description: p.description.slice(0, 5000),
        pricePaise,
        mrpPaise: mrpPaise !== null && mrpPaise >= pricePaise ? mrpPaise : null,
        images: httpsOnly(p.images).slice(0, 12),
        categories: p.categories.slice(0, 20),
        featured: p.featured,
      };
    }),
  });
}

export const CATALOGUE_FORMATS = Object.freeze(['bhava', 'legacy']);

/**
 * Where a business's products come from. Paths are relative to the seed file.
 *   file      a catalogue committed under seed/
 *   setting   a file outside the repository, named by a setting or a flag (SHOWCASE.plantSetting, SHOWCASE.plantFlag);
 *             when neither is given the committed `fallback` is used, so CI never depends on a sibling folder.
 *             The outside file is read where it is and never copied into the repository.
 */
export const ProductSource = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('file'), file: z.string().min(1).max(300), format: z.enum(CATALOGUE_FORMATS) }),
  z.strictObject({
    from: z.literal('setting'),
    setting: z.literal(SHOWCASE.plantSetting),
    format: z.enum(CATALOGUE_FORMATS),
    fallback: z.strictObject({ file: z.string().min(1).max(300), format: z.enum(CATALOGUE_FORMATS) }),
  }),
]);

const TRIGGERS = ['comment', 'story_reply', 'story_mention', 'dm_keyword', 'dm_welcome'];
const LINKS = ['seller_site', 'bhava_page', 'amazon', 'affiliate', 'whatsapp'];
const Keyword = z.string().trim().min(1).max(40);

export const ShowcaseSeed = z.strictObject({
  schema: z.literal(1),
  business: z.strictObject({
    slug: Slug.max(40),
    name: Name,
    legalName: Words(200),
    accountType: z.enum(ACCOUNT_TYPES),
    plan: z.enum(PLANS),
    cycle: z.enum(['monthly', 'yearly']).default('monthly'),
    /** The made-up Instagram account the simulator answers for: never a real handle or id. */
    igUsername: z.string().regex(PEOPLE_RULES.instagram.username),
    igUserId: z.string().regex(PEOPLE_RULES.instagram.id),
    owner: Person,
  }),
  /** The look (repos.brandKit): a preset of ThemeTemplate, colours over it by slot, fonts, and the public replies. */
  brandKit: z.strictObject({
    preset: z.string().min(1).max(40),
    colors: z.record(z.string().regex(/^[a-z_]{1,40}$/), Hex).default({}),
    headingFont: Words(80),
    bodyFont: Words(80),
    /** Image files beside the seed file, uploaded through the storage module; '' for none. */
    logo: Words(300),
    logoDark: Words(300),
    favicon: Words(300),
    publicReplyVariants: z.array(z.string().trim().min(1).max(150)).max(10).default([]),
  }),
  /** What the branded shopper app is built from (the app config's own fields; the brand file is exported from them). */
  app: z.strictObject({
    appName: z.string().trim().min(1).max(30),
    shortName: z.string().trim().min(1).max(12),
    urlScheme: z.string().regex(/^[a-z][a-z0-9]{2,30}$/),
    androidPackage: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$/).max(150),
    iosBundleId: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){1,5}$/).max(155).nullable().default(null),
    splashBackground: Hex,
    icon: Words(300),
    splash: Words(300),
    supportEmail: z.string().refine(emailInvented, 'Use an example domain'),
  }),
  products: ProductSource,
  /** Extra categories, or none when the catalogue brings its own. Matched by name. */
  categories: z.array(SeedCategory).max(200).default([]),
  /** In the order they show. `key` is how automations and pages below point at a reel. */
  reels: z.array(z.strictObject({
    key: Slug.max(40),
    igMediaId: MadeUpMediaId,
    kind: z.enum(['reel', 'post', 'story']).default('reel'),
    caption: Words(2200),
    headline: Words(120),
    slug: Slug,
    categories: z.array(Name).max(20).default([]),
    products: z.array(Name).max(60).default([]),
    /** As well as the named products: the first n of the catalogue not already named, for a catalogue not known ahead. */
    fill: z.number().int().min(0).max(60).default(0),
  })).max(100).default([]),
  /** Landing pages, in order; `reel` is a reel's key, or null for a page with no reel behind it. */
  landingPages: z.array(z.strictObject({
    slug: Slug,
    title: Name,
    kind: z.enum(['reel', 'post', 'story']).default('reel'),
    reel: Slug.nullable().default(null),
    categories: z.array(Name).max(20).default([]),
    products: z.array(Name).max(60).default([]),
    fill: z.number().int().min(0).max(60).default(0),
  })).max(100).default([]),
  /** Saved through the automations module's own handlers, so each one passes the compliance checks an owner's would. */
  automations: z.array(z.strictObject({
    name: Name,
    reel: Slug.nullable().default(null),
    trigger: z.enum(TRIGGERS),
    keywords: z.array(Keyword).max(20).default([]),
    message: z.string().trim().min(1).max(640),
    buttonText: Words(20),
    link: z.strictObject({ type: z.enum(LINKS), page: Slug.nullable().default(null), url: z.union([Link, z.literal('')]).default('') }),
    state: z.enum(['draft', 'test', 'live', 'paused']).default('live'),
  })).max(100).default([]),
  faq: z.array(z.strictObject({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(1000) })).max(200).default([]),
  coupons: z.array(z.strictObject({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
    kind: z.enum(['percent', 'flat', 'free_shipping']),
    /** percent: hundredths of a percent (10% is 1000). */
    percentBp: z.number().int().min(1).max(10000).optional(),
    amountPaise: Paise.optional(),
    maxDiscountPaise: Paise.optional(),
    minOrderPaise: Paise.default(0),
    maxUses: z.number().int().positive().nullable().default(null),
    maxUsesPerCustomer: z.number().int().positive().nullable().default(null),
  }).refine((c) => (c.kind === 'percent') === (c.percentBp !== undefined) && (c.kind === 'flat') === (c.amountPaise !== undefined), 'A percent coupon has percentBp, a flat one amountPaise, free shipping neither')).max(50).default([]),
  /** Store settings by key (repos.settings): text values only, filled in where the owner has not changed them. */
  settings: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), z.string().max(5000)).default({}),
}).superRefine((seed, ctx) => {
  const keys = new Set(seed.reels.map((reel) => reel.key));
  const pages = new Set(seed.landingPages.map((page) => page.slug));
  const unique = (list, path) => {
    if (new Set(list).size !== list.length) ctx.addIssue({ code: 'custom', message: 'Each one must be different', path });
  };
  unique(seed.reels.map((r) => r.key), ['reels']);
  unique(seed.reels.map((r) => r.igMediaId), ['reels']);
  unique([...seed.reels.map((r) => r.slug), ...seed.landingPages.map((p) => p.slug)], ['landingPages']);
  unique(seed.coupons.map((c) => c.code), ['coupons']);
  seed.landingPages.forEach((page, index) => {
    if (page.reel !== null && !keys.has(page.reel)) ctx.addIssue({ code: 'custom', message: 'No reel has this key', path: ['landingPages', index, 'reel'] });
  });
  seed.automations.forEach((automation, index) => {
    if (automation.reel !== null && !keys.has(automation.reel)) ctx.addIssue({ code: 'custom', message: 'No reel has this key', path: ['automations', index, 'reel'] });
    if (automation.link.page !== null && !pages.has(automation.link.page)) ctx.addIssue({ code: 'custom', message: 'No landing page has this slug', path: ['automations', index, 'link', 'page'] });
    if (automation.link.type === 'bhava_page' ? automation.link.page === null : automation.link.url === '') ctx.addIssue({ code: 'custom', message: 'A link needs its page or its address', path: ['automations', index, 'link'] });
    if ((automation.trigger === 'comment' || automation.trigger === 'dm_keyword') && automation.keywords.length === 0) ctx.addIssue({ code: 'custom', message: 'This trigger needs a keyword', path: ['automations', index, 'keywords'] });
  });
});

/** The list of sample businesses: a neutral key each (what CI and the tools use) and the seed file beside the manifest. */
export const ShowcaseManifest = z.strictObject({
  schema: z.literal(1),
  businesses: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9-]{1,20}$/), file: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,80}\.json$/) })).min(1).max(10),
}).refine((manifest) => new Set(manifest.businesses.map((b) => b.key)).size === manifest.businesses.length, 'Each key must be different');

/**
 * Names a seed's products, reels and pages point at that are not there: [{ path, name }]. `catalogue` is the SeedCatalogue
 * the seed's product source resolved to. Empty means every reference lands.
 */
export function danglingReferences(seed, catalogue) {
  const products = new Set(catalogue.products.map((p) => p.name));
  const categories = new Set([...catalogue.categories, ...seed.categories].map((c) => c.name));
  const missing = [];
  catalogue.products.forEach((product, i) => product.categories.forEach((name) => {
    if (!categories.has(name)) missing.push({ path: `catalogue.products[${i}].categories`, name });
  }));
  for (const [list, items] of [['reels', seed.reels], ['landingPages', seed.landingPages]]) {
    items.forEach((item, i) => {
      item.products.forEach((name) => { if (!products.has(name)) missing.push({ path: `${list}[${i}].products`, name }); });
      item.categories.forEach((name) => { if (!categories.has(name)) missing.push({ path: `${list}[${i}].categories`, name }); });
    });
  }
  return missing;
}
