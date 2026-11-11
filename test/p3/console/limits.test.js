// The console can import nothing from the server but the API's access rules, so the Phase 3 screens carry their own copy of the
// contract's numbers and names. This keeps each copy equal to the server's, value for value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LIMITS, CSV_COLUMNS, FETCH_STATUSES, IMPORT_ITEM_STATUSES, IMPORT_JOB_STATUSES, IMPORT_KINDS, NEEDS_ATTENTION, PLAN_REASON, PRODUCT_SOURCES } from '../../../src/contracts/catalog.js';
import { BUYER_BLOCKS, DEFAULT_BLOCKS, LEAD_SURFACES, PAGE_SURFACES } from '../../../src/contracts/buyer-pages.js';
import { SEAL_TEXT_MAX, TICKER_ITEMS_MAX, TICKER_ITEM_LENGTH } from '../../../src/contracts/themes.js';
import { RULE_MATCHES } from '../../../src/contracts/api/categories.js';
import { CSV_UPLOAD, ImportItemsQuery } from '../../../src/contracts/api/imports.js';
import { CONSENT_CHANNELS, LeadListQuery } from '../../../src/contracts/api/leads.js';
import { LANDING_KINDS, PageListQuery } from '../../../src/contracts/api/pages.js';
import { ProductListQuery } from '../../../src/contracts/api/products.js';
import * as limits from '../../../console/src/features/catalog/shared/limits.js';
import { SOURCE_CHOICES, STATUS_TABS } from '../../../console/src/features/catalog/form.js';
import { ITEM_FILTERS, WAYS, kindText } from '../../../console/src/features/imports/form.js';
import { BLOCK_FIELDS, BLOCK_TEXT, KIND_TABS, STATUS_TABS as PAGE_STATUS_TABS, SURFACES } from '../../../console/src/features/pages/form.js';
import { MATCH_CHOICES } from '../../../console/src/features/categories/sequence.js';
import { CHANNEL_CHOICES, CONSENT_TABS, SOURCE_TABS, surfaceText } from '../../../console/src/features/leads/form.js';

const keys = (pairs) => pairs.map(([key]) => key);
const enumOf = (schema, field) => schema.shape[field].unwrap ? [...schema.shape[field].unwrap().options] : [...schema.shape[field].options];

test('the catalog numbers are the server\'s', () => {
  for (const [name, value] of Object.entries(limits.CATALOG)) assert.equal(value, CATALOG_LIMITS[name], name);
  assert.equal(limits.PLAN_REASON, PLAN_REASON);
  assert.deepEqual([...limits.FETCH_STATUSES], [...FETCH_STATUSES]);
  assert.deepEqual([...limits.NEEDS_ATTENTION], [...NEEDS_ATTENTION]);
  assert.deepEqual([...limits.IMPORT_JOB_STATUSES], [...IMPORT_JOB_STATUSES]);
  assert.deepEqual([...limits.IMPORT_ITEM_STATUSES], [...IMPORT_ITEM_STATUSES]);
  assert.deepEqual([...limits.CSV_COLUMNS], [...CSV_COLUMNS]);
  assert.deepEqual([...limits.CSV_TYPES], [...CSV_UPLOAD.mimeTypes]);
  assert.equal(limits.CATALOG.csvBytes, CSV_UPLOAD.maxBytes);
  assert.deepEqual([...limits.PRODUCT_SOURCES], [...PRODUCT_SOURCES, 'adapter']);
});

test('the largest amount a price field takes is the API\'s', async () => {
  const { PaiseInput } = await import('../../../src/contracts/api/common.js');
  assert.equal(PaiseInput.safeParse(limits.MAX_PAISE).success, true);
  assert.equal(PaiseInput.safeParse(limits.MAX_PAISE + 1).success, false);
});

test('the blocks, their surfaces and their settings are the server\'s', () => {
  assert.deepEqual(Object.keys(limits.BLOCKS), Object.keys(BUYER_BLOCKS));
  for (const [name, block] of Object.entries(BUYER_BLOCKS)) {
    assert.deepEqual([...limits.BLOCKS[name].surfaces], [...block.surfaces], name);
    assert.deepEqual([...limits.BLOCKS[name].settings], [...block.settings], name);
  }
  for (const surface of PAGE_SURFACES) assert.deepEqual([...limits.DEFAULT_BLOCKS[surface]], [...DEFAULT_BLOCKS[surface]], surface);
  assert.deepEqual([...limits.PAGE_SURFACES], [...PAGE_SURFACES]);
  assert.deepEqual(keys(SURFACES), [...PAGE_SURFACES]);
});

test('every block has words, and a field for each setting it takes', () => {
  for (const [name, block] of Object.entries(BUYER_BLOCKS)) {
    assert.ok(BLOCK_TEXT[name]?.[0], `${name}: no name for the owner`);
    assert.deepEqual((BLOCK_FIELDS[name] ?? []).map((field) => field.name), [...block.settings], `${name}: settings`);
  }
});

test('the look\'s word limits, lead surfaces, consent channels, kinds and rule matches are the server\'s', () => {
  assert.deepEqual({ ...limits.THEME_TEXT }, { sealText: SEAL_TEXT_MAX, tickerItems: TICKER_ITEMS_MAX, tickerItem: TICKER_ITEM_LENGTH });
  assert.deepEqual([...limits.LEAD_SURFACES], [...LEAD_SURFACES]);
  assert.deepEqual([...limits.CONSENT_CHANNELS], [...CONSENT_CHANNELS]);
  assert.deepEqual([...limits.LANDING_KINDS], [...LANDING_KINDS]);
  assert.deepEqual([...limits.RULE_MATCHES], [...RULE_MATCHES]);
  assert.deepEqual(keys(MATCH_CHOICES), [...RULE_MATCHES]);
  assert.deepEqual(keys(CHANNEL_CHOICES), [...CONSENT_CHANNELS]);
  for (const surface of LEAD_SURFACES) assert.ok(surfaceText(surface)[1], `${surface}: no words`);
});

test('every filter a screen offers is one the API takes, and none the API has is missing', () => {
  assert.deepEqual(keys(STATUS_TABS).sort(), enumOf(ProductListQuery, 'status').sort());
  assert.deepEqual(keys(SOURCE_CHOICES).filter(Boolean).sort(), enumOf(ProductListQuery, 'source').sort());
  assert.deepEqual(keys(KIND_TABS).sort(), enumOf(PageListQuery, 'kind').sort());
  assert.deepEqual(keys(PAGE_STATUS_TABS).sort(), enumOf(PageListQuery, 'status').sort());
  assert.deepEqual(keys(SOURCE_TABS).sort(), enumOf(LeadListQuery, 'source').sort());
  assert.deepEqual(keys(CONSENT_TABS).sort(), enumOf(LeadListQuery, 'consent').sort());
  const itemStatuses = enumOf(ImportItemsQuery, 'status');
  for (const key of keys(ITEM_FILTERS)) assert.ok(itemStatuses.includes(key), `import items: ${key}`);
});

test('every kind of import has a way in or a name', () => {
  for (const kind of IMPORT_KINDS) assert.notEqual(kindText(kind), 'Import', kind);
  assert.deepEqual(keys(WAYS), ['link', 'bulk', 'shopify', 'csv']);
});
