import { z } from 'zod';

/**
 * Importing an old single-shop app into one business (PRD 5.16, F-68 to F-73), as data. The importer is
 * src/modules/migration; its tables are migration 800. No database here.
 *
 * The source is an export of the old app: its tables as rows, read from a database dump or made by a test from fixtures.
 * An export holds one shop. The importer never reads the old app's database itself and never reaches a live service.
 */
export const MIGRATION_MODES = Object.freeze(['dry', 'real']);
export const MIGRATION_STATUSES = Object.freeze(['running', 'done', 'failed']);

/**
 * The old app's tables the importer knows, in the order they are imported (a parent before its children). A table of the
 * export that is not here is a conflict of kind `unknown_table`, never silently dropped.
 */
export const LEGACY_TABLES = Object.freeze([
  'settings', 'media', 'categories', 'products', 'product_categories', 'reels', 'reel_products', 'users', 'orders', 'order_items', 'activity', 'visits',
]);

/** What is carried across unchanged, per table: every other id is remapped (migration_id_map). */
export const MIGRATION_KEEPS = Object.freeze({
  products: Object.freeze(['slug']),
  categories: Object.freeze(['slug']),
  reels: Object.freeze(['slug']),
  orders: Object.freeze(['order_number', 'public_token']),
  media: Object.freeze(['data', 'mime']),
});

/** What is blanked on the way in (F-71): the new rows hold no username and no comment or message text. */
export const MIGRATION_STRIPS = Object.freeze({
  activity: Object.freeze(['username', 'comment_text', 'message_text', 'text']),
  visits: Object.freeze(['username']),
});

/**
 * What is never copied: shoppers sign in again by Google or a WhatsApp code (F-72 finds their orders by phone), the
 * owner is re-invited, and the business connects its own Instagram account.
 */
export const MIGRATION_NEVER_COPIED = Object.freeze(['users.password_hash', 'settings.ig_token', 'settings.access_token', 'sessions', 'the .env owner']);

/** After a real run the business's order counter is the highest migrated order number plus one (F-70). */
export const nextOrderNumber = (highestMigrated, current = 1) => Math.max(Number(current) || 1, (Number(highestMigrated) || 0) + 1);

/**
 * `blocking` conflicts stop a real run before anything is written. `reel_on_other_account` (F-73): a reel of this shop
 * was posted on an Instagram account that belongs to another business; it stays blocked until the operator chooses.
 */
export const CONFLICT_KINDS = Object.freeze({
  slug_taken: Object.freeze({ blocking: true }),
  order_number_taken: Object.freeze({ blocking: true }),
  public_token_taken: Object.freeze({ blocking: true }),
  reel_on_other_account: Object.freeze({ blocking: true }),
  unknown_table: Object.freeze({ blocking: true }),
  orphan_row: Object.freeze({ blocking: false }),
  duplicate_phone: Object.freeze({ blocking: false }),
});
export const REEL_CHOICES = Object.freeze(['drop', 'reassign']);

const Table = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const MigrationSource = z.strictObject({
  format: z.literal('bhava-legacy-export'),
  version: z.literal(1),
  /** A label for the run's record: the old app's name or the dump's file name. Never a secret. */
  label: z.string().trim().min(1).max(200),
  exportedAt: z.string().max(40).default(''),
  /** The Instagram account id the old shop's reels were posted on, when the export knows it. */
  igUserId: z.string().max(40).default(''),
  tables: z.record(Table, z.array(z.record(z.string(), z.unknown()))),
});

export const MigrationOptions = z.strictObject({
  /** The business to import into: it exists already (created in the Platform Console), and is empty or part-imported. */
  tenantId: z.number().int().positive(),
  /** F-73: what to do with reels posted on another business's Instagram account. Left out, they block. */
  reels: z.enum(REEL_CHOICES).optional(),
  startedBy: z.number().int().positive().nullable().default(null),
});

export const MigrationConflict = z.strictObject({
  kind: z.enum(Object.keys(CONFLICT_KINDS)),
  table: Table,
  /** The old row's id as text; '' for a conflict about a whole table. Ids and codes only: never a username or a message. */
  oldId: z.string().max(200),
  blocking: z.boolean(),
});

const TableCount = z.strictObject({ source: z.number().int().nonnegative(), imported: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() });

/** What plan() answers, and what run() answers with `runId` set: counts per table and every conflict. */
export const MigrationReport = z.strictObject({
  mode: z.enum(MIGRATION_MODES),
  tenantId: z.number().int().positive(),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** In a dry run `imported` is what a real run would write; rows already imported by an earlier run count as skipped. */
  counts: z.record(Table, TableCount),
  conflicts: z.array(MigrationConflict),
  blocked: z.boolean(),
  /** True when a finished real run of this same export into this business already exists: run() then writes nothing. */
  alreadyImported: z.boolean(),
  runId: z.number().int().positive().nullable(),
  nextOrderNumber: z.number().int().positive().nullable(),
});

/** Every table: source = imported + skipped. A real run that ends otherwise is rolled back whole. */
export const countsBalance = (counts) => Object.values(counts).every((c) => c.source === c.imported + c.skipped);
