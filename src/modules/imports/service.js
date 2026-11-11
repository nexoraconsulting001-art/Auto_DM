import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { CATALOG_LIMITS as L, CatalogRuleError, IMPORT_REASONS, PLAN_REASON, canonicalProductUrl, checkMrp } from '../../contracts/catalog.js';
import { log, reportError } from '../../platform/log.js';
import { ImageError } from '../../platform/images.js';
import { SafeFetchError } from '../../platform/safe-fetch.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { invalidField } from '../admin-api/errors.js';
import { isRowId, readCursor, writeCursor } from '../admin-api/paging.js';
import { applyImport, createFromDraft } from '../catalog/imported.js';
import { violated } from '../catalog/repo.js';
import { checkOptionsAndVariants } from '../catalog/rules.js';
import { createAdapterRegistry } from './adapters.js';
import { readCsvFile, rowToProduct } from './csv.js';
import { qualityGate } from './gate.js';
import { createReader } from './read.js';
import { itemMessage } from './repo.js';
import { feedUrl, fromShopify } from './shopify.js';
import { plainLine } from './text.js';

/**
 * Imports (PRD 8.3 to 8.7): a pasted link answers at once with a draft; bulk links, CSV files and a Shopify store's public feed
 * are jobs with a report per item. One business's job reads and writes only that business: every step runs as the job's
 * business and finds the job through it, so a job id from anywhere else finds nothing.
 *
 * A job is worked in steps of a few minutes. What is left to do is in the database (the items still pending), so a step that
 * stops, or runs twice, picks up where the items say.
 */

export const RUN = 'imports.run';
export const IMAGE = 'imports.image';

const MAX_PASSES = 5;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const hostOf = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
const isWeb = (link) => /^https?:\/\//i.test(link ?? '');

const paise = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const texts = (list, max) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string').slice(0, max) : []);

/** A stored draft in the API's shape, or null when the item holds no product (a CSV row before it is read, say). */
export function toApiDraft(d) {
  if (!d || typeof d.name !== 'string') return null;
  return {
    name: d.name,
    description: typeof d.description === 'string' ? d.description : '',
    externalUrl: typeof d.externalUrl === 'string' ? d.externalUrl : '',
    pricePaise: paise(d.pricePaise),
    mrpPaise: paise(d.mrpPaise),
    inStock: d.inStock !== false,
    images: texts(d.images, L.images),
    tags: texts(d.tags, L.tags),
    suggestedCategories: texts(d.suggestedCategories, 20),
    options: (Array.isArray(d.options) ? d.options : []).filter((o) => o && typeof o.name === 'string').map((o) => ({ name: o.name, values: texts(o.values, L.optionValues) })),
    variants: (Array.isArray(d.variants) ? d.variants : []).filter((v) => v && paise(v.pricePaise) !== null)
      .map((v) => ({ optionValues: texts(v.optionValues, L.options), sku: typeof v.sku === 'string' ? v.sku : '', pricePaise: v.pricePaise, mrpPaise: paise(v.mrpPaise), inStock: v.inStock !== false })),
    source: typeof d.source === 'string' ? d.source : 'link',
    sourceRef: typeof d.sourceRef === 'string' ? d.sourceRef : '',
  };
}

const reasonOrNull = (code) => (Object.hasOwn(IMPORT_REASONS, code ?? '') ? code : null);

export const toJob = (j) => ({
  id: j.id, kind: j.kind, status: j.status, source: j.source, total: j.total, created: j.created, updated: j.updated, unchanged: j.unchanged, refused: j.refused,
  failed: j.failed, archived: j.archived, errorCode: reasonOrNull(j.error_code), message: IMPORT_REASONS[j.error_code] ?? '', createdAt: j.created_at, finishedAt: j.finished_at,
});

export const toItem = (i) => ({
  id: i.id, line: i.line, url: i.url, sku: i.sku, status: i.status, readFrom: i.read_from, gatePassed: i.gate_passed, reason: reasonOrNull(i.reason),
  message: itemMessage(i), productId: i.product_id, draft: toApiDraft(i.draft),
});

/** The store's address as its origin: "plants.example", "https://plants.example/collections/all". Null when it isn't one. */
export function storeOrigin(input) {
  let text = String(input ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createImports(ctx) {
  const { repos, platform, config = {} } = ctx;
  const catalog = repos.catalog;
  const imports = repos.imports;
  const adapters = createAdapterRegistry(config.siteAdapters);
  const reader = createReader({ fetcher: platform.fetcher, adapters });
  const budgetMs = config.importBudgetMs ?? 180_000;

  async function mustBeInPlan() {
    if (!(await repos.entitlements.can('catalog.import'))) throw new ApiError('forbidden', 'Importing products isn’t part of your plan.', { reason: PLAN_REASON });
  }

  /** Queues the copy of a product's first image into the business's media (8.3). Once per product and image. */
  async function queueImage(productId, firstImage) {
    if (!isWeb(firstImage)) return;
    const tid = tenantId();
    await platform.queue.enqueue(IMAGE, { productId }, { tenantId: tid, dedupeKey: `img:${tid}:${productId}:${sha(firstImage)}`, maxAttempts: 3, retryInFlight: true });
  }

  /**
   * Copies a product's first image into the business's media, cleaned by platform.images. When it can't be (too large, not
   * an image, the site refused), the original address stays. Throws only for a failure worth another try.
   */
  async function copyFirstImage(productId) {
    const product = await catalog.get(productId);
    const first = product?.gallery.find((g) => g.position === 0);
    if (!first || first.media_id || !isWeb(first.source_url)) return false;
    try {
      const fetched = await platform.fetcher.image(first.source_url);
      const clean = await platform.images.ingest(fetched.buffer);
      const mediaId = await repos.media.save(clean.buffer, clean.contentType);
      return await catalog.useCopiedImage(productId, first.source_url, { mediaId, width: clean.width, height: clean.height });
    } catch (err) {
      if (err instanceof SafeFetchError && err.retryable) throw err;
      if (err instanceof SafeFetchError || err instanceof ImageError) return false;
      throw err;
    }
  }

  /**
   * Reads one address and judges it: { status: 'failed' | 'existing' | 'refused' | 'draft', reason, readFrom, gatePassed, draft,
   * productId, busy }. The draft carries its source, so saving it later needs nothing else.
   */
  async function judge(input, state) {
    const none = { reason: null, readFrom: '', gatePassed: null, draft: null, productId: null, busy: false };
    const url = canonicalProductUrl(input);
    if (!url) return { ...none, status: 'failed', reason: 'blocked' };
    let existing = await catalog.idByExternalUrl(url);
    if (existing) return { ...none, status: 'existing', reason: 'duplicate', productId: existing };
    const read = await reader.read(url, { enabledAdapters: state.enabled, homes: state.homes });
    if (!read.ok) return { ...none, status: 'failed', reason: read.reason, busy: read.reason === 'host_busy' };
    if (!read.draft) return { ...none, status: 'refused', reason: 'no_title', gatePassed: false };
    const draft = { ...read.draft, externalUrl: read.draft.externalUrl || url, source: read.source, sourceRef: read.sourceRef, mrpKnown: read.mrpKnown };
    if (draft.externalUrl !== url) existing = await catalog.idByExternalUrl(draft.externalUrl);
    existing ??= read.sourceRef ? await catalog.idBySourceRef(read.source, read.sourceRef) : null;
    if (existing) return { ...none, status: 'existing', reason: 'duplicate', productId: existing };
    const verdict = qualityGate({ url, finalUrl: read.finalUrl, readFrom: read.readFrom, draft, page: read.page, home: read.home });
    return { ...none, status: verdict.passed ? 'draft' : 'refused', reason: verdict.reason, readFrom: read.readFrom, gatePassed: verdict.passed, draft };
  }

  const newState = async () => ({ enabled: await imports.enabledAdapters(), homes: new Map(), hours: await catalog.recheckHours(), categories: new Map() });

  /** The ids of categories by these names, made when the business has none by that name (a CSV's own category column). */
  async function categoryIds(names, state) {
    const ids = [];
    for (const name of names ?? []) {
      const key = name.toLowerCase();
      if (!state.categories.has(key)) {
        let found = await repos.categories.findByName(name);
        if (!found) {
          try {
            const all = await repos.categories.list();
            found = await repos.categories.save(null, { name, visible: true, position: all.length ? Math.max(...all.map((c) => c.position)) + 1 : 1 });
          } catch (err) {
            if (!(err instanceof ValidationError) && err?.code !== '23505') throw err;
            found = await repos.categories.findByName(name);
          }
        }
        state.categories.set(key, found?.id ?? null);
      }
      if (state.categories.get(key)) ids.push(state.categories.get(key));
    }
    return ids;
  }

  // ---- one item of a job, by kind. Each answers the item's new fields, or 'later' to leave it waiting. ----

  async function bulkItem(item, state) {
    const result = await judge(item.url, state);
    if (result.busy) return 'later';
    const fields = { status: result.status, reason: result.reason ?? '', readFrom: result.readFrom, gatePassed: result.gatePassed, draft: result.draft, productId: result.productId };
    if (result.status !== 'draft') return fields;
    // Accepted by the gate. With a price it becomes a product now; without one it waits for the owner to add it (K-23).
    if (result.draft.pricePaise === null) return { ...fields, message: 'No price was found. Add one to save this product.' };
    const productId = await createFromDraft(catalog, result.draft, { source: result.draft.source, sourceRef: result.draft.sourceRef, recheckHours: state.hours });
    await queueImage(productId, result.draft.images[0]);
    return { ...fields, status: 'created', productId };
  }

  async function csvItem(item, state) {
    const row = rowToProduct(item.draft?.cells);
    const bySku = await catalog.idBySku(row.sku);
    const byUrl = await catalog.idByExternalUrl(row.externalUrl);
    if (bySku && byUrl && bySku !== byUrl) throw new CatalogRuleError('duplicate', 'url');
    const productId = bySku ?? byUrl;
    const categories = await categoryIds(row.categories, state);
    if (productId) {
      if (row.pricePaise === undefined && row.mrpPaise !== undefined && row.mrpPaise !== null) checkMrp((await catalog.get(productId)).price_paise, row.mrpPaise);
      await applyImport(catalog, productId, { ...row, variants: undefined }, { manualPrice: true, addCategoryIds: categories, recheckHours: state.hours });
      if (row.images?.length) await queueImage(productId, row.images[0]);
      return { status: 'updated', readFrom: 'csv', productId };
    }
    if (!row.name) throw new CatalogRuleError('no_title', 'title');
    if (row.pricePaise === undefined) throw new CatalogRuleError('bad_price', 'price');
    const draft = { name: row.name, description: '', pricePaise: row.pricePaise, mrpPaise: row.mrpPaise ?? null, inStock: row.inStock ?? true, images: row.images ?? [], tags: [], options: row.options ?? [], variants: [], externalUrl: row.externalUrl ?? '', sku: row.sku };
    const created = await createFromDraft(catalog, draft, { source: 'csv', priceManual: true, categoryIds: categories, recheckHours: state.hours });
    await queueImage(created, draft.images[0]);
    return { status: 'created', readFrom: 'csv', productId: created };
  }

  async function feedItem(item, state) {
    const draft = item.draft;
    const verdict = qualityGate({ url: draft.externalUrl, readFrom: 'feed', draft });
    if (!verdict.passed) return { status: 'refused', gatePassed: false, reason: verdict.reason };
    const productId = (await catalog.idBySourceRef('shopify', draft.sourceRef)) ?? (await catalog.idByExternalUrl(draft.externalUrl));
    if (productId) {
      const result = await applyImport(catalog, productId, draft, { flagPrice: true, claim: { source: 'shopify', sourceRef: draft.sourceRef }, recheckHours: state.hours });
      if (result?.changed) await queueImage(productId, draft.images[0]);
      return { status: result?.changed ? 'updated' : 'unchanged', gatePassed: true, productId };
    }
    const created = await createFromDraft(catalog, draft, { source: 'shopify', sourceRef: draft.sourceRef, recheckHours: state.hours });
    await queueImage(created, draft.images[0]);
    return { status: 'created', gatePassed: true, productId: created };
  }

  const ITEM = { bulk: bulkItem, csv: csvItem, shopify: feedItem };

  async function workItem(job, item, state) {
    try {
      const fields = await ITEM[job.kind](item, state);
      if (fields === 'later') return false;
      // Every item leaves here settled, so a run can never go round the same one twice.
      await imports.setItem(item.id, fields?.status && fields.status !== 'pending' ? fields : { status: 'failed', reason: 'bad_row' });
    } catch (err) {
      if (err instanceof CatalogRuleError) await imports.setItem(item.id, { status: 'refused', reason: err.code });
      else if (err instanceof ValidationError) await imports.setItem(item.id, { status: 'refused', reason: 'bad_row', message: err.message });
      else if (violated(err, 'products_external_url_idx') || violated(err, 'products_source_ref_idx') || violated(err, 'product_variants_sku_idx')) await imports.setItem(item.id, { status: 'refused', reason: 'duplicate' });
      else {
        reportError(err, { msg: 'imports.item_failed', tenantId: tenantId(), jobId: job.id, itemId: item.id });
        await imports.setItem(item.id, { status: 'failed', reason: job.kind === 'bulk' ? 'network' : 'bad_row' });
      }
    }
    return true;
  }

  /** Works the waiting items until none is left or the time is up. Answers { left, moved }: items still waiting, and whether any was done. */
  async function workItems(job, state, deadline) {
    const later = new Set();
    let moved = false;
    for (;;) {
      const batch = (await imports.pending(job.id, 50 + later.size)).filter((item) => !later.has(item.id));
      if (!batch.length) break;
      for (const item of batch) {
        if (Date.now() > deadline) return { left: true, moved };
        if (await workItem(job, item, state)) moved = true;
        else later.add(item.id);
      }
      await imports.count(job.id);
    }
    return { left: later.size > 0, moved };
  }

  /**
   * Reads the store's public feed from `page` on, a page at a time until an empty one (8.5), adding each product as a waiting
   * item. Answers { done }, { page } to carry on from, or { failed } when the feed can't be read.
   */
  async function readFeed(job, origin, page, deadline, lastTry) {
    const host = hostOf(origin);
    for (let p = page; p <= L.shopifyMaxPages; p++) {
      if (Date.now() > deadline) return { page: p };
      let products;
      try {
        const { data } = await platform.fetcher.json(feedUrl(origin, p), { profile: 'feed' });
        products = Array.isArray(data?.products) ? data.products : null;
      } catch (err) {
        if (!(err instanceof SafeFetchError)) throw err;
        if (err.retryable && !lastTry) throw err; // the queue tries this page again shortly
        products = null;
      }
      if (!products) return { failed: true };
      if (!products.length) return { done: true };
      await imports.addItems(job.id, products.slice(0, L.shopifyPageSize).map((product, index) => {
        const line = (p - 1) * L.shopifyPageSize + index + 1;
        const draft = fromShopify(product, origin);
        if (!draft) return { line, status: 'failed', reason: 'bad_row', readFrom: 'feed' };
        return { line, url: draft.externalUrl, readFrom: 'feed', draft: { ...draft, source: 'shopify', sourceRef: `${host}/${draft.handle}` } };
      }));
    }
    return { done: true };
  }

  /** Products of this store that the feed no longer lists are archived into Needs attention (8.5), and the owner is told once. */
  async function archiveMissing(job, origin) {
    const host = hostOf(origin);
    const seen = new Set(await imports.productIds(job.id));
    const gone = (await catalog.fromStore('shopify', host)).filter((p) => !seen.has(p.id) && p.fetch_status !== 'missing').map((p) => p.id);
    const archived = await catalog.archiveMissing(gone);
    if (!archived.length) return;
    const from = await imports.lastLine(job.id);
    await imports.addItems(job.id, archived.map((productId, index) => ({ line: from + index + 1, status: 'archived', readFrom: 'feed', productId, message: 'No longer in the store’s product list.' })));
    await repos.alerts.raise({
      kind: 'catalog.products_missing',
      severity: 'warning',
      message: `${archived.length} ${archived.length === 1 ? 'product is' : 'products are'} no longer in your store’s list and ${archived.length === 1 ? 'has' : 'have'} been archived. See Needs attention.`,
      target: `import:${job.id}`,
      dedupeKey: `catalog.missing:${job.id}`,
    });
  }

  const continueLater = (payload, delayMs = 0) => platform.queue.enqueue(RUN, payload, { tenantId: tenantId(), delayMs, maxAttempts: 5, retryInFlight: true });

  /**
   * One step of a job. `payload` is { jobId, origin, page, feedDone, passes }; `lastTry` says the queue won't run this step
   * again, so whatever fails now ends the job instead of leaving it running for ever.
   */
  async function run(payload, { lastTry = false, inline = false } = {}) {
    const job = await imports.job(payload?.jobId);
    if (!job || !(await imports.start(job.id))) return null;
    const deadline = Date.now() + budgetMs;
    try {
      if (job.kind === 'shopify' && !payload.feedDone) {
        const feed = await readFeed(job, payload.origin, payload.page ?? 1, deadline, lastTry);
        if (feed.page) {
          await imports.count(job.id);
          await continueLater({ ...payload, page: feed.page });
          return job;
        }
        if (feed.failed || (await imports.lastLine(job.id)) === 0) await imports.setError(job.id, 'feed_unavailable');
      }
      const state = await newState();
      const { left, moved } = await workItems(job, state, inline ? Infinity : deadline);
      if (left) {
        const passes = (payload.passes ?? 0) + (moved ? 0 : 1);
        if (passes < MAX_PASSES) {
          await continueLater({ ...payload, feedDone: true, passes }, moved ? 0 : 5000);
          return job;
        }
        for (const item of await imports.pending(job.id, 5000)) await imports.setItem(item.id, { status: 'failed', reason: 'host_busy' });
      }
      const failed = Boolean((await imports.job(job.id)).error_code);
      if (job.kind === 'shopify' && !failed) await archiveMissing(job, payload.origin);
      const done = await imports.finish(job.id, { status: failed ? 'failed' : 'done' });
      log.info('imports.job_done', { tenantId: tenantId(), jobId: job.id, kind: job.kind, status: done.status, total: done.total, created: done.created, updated: done.updated, refused: done.refused, failed: done.failed });
      return done;
    } catch (err) {
      if (lastTry || inline) {
        reportError(err, { msg: 'imports.job_failed', tenantId: tenantId(), jobId: job.id });
        await imports.finish(job.id, { status: 'failed' });
        if (inline) return imports.job(job.id);
      }
      throw err;
    }
  }

  const enqueueRun = (payload) => platform.queue.enqueue(RUN, payload, { tenantId: tenantId(), maxAttempts: 5, retryInFlight: true });

  return {
    adapters,
    reader,
    run,
    copyFirstImage,

    // ---- the seller API ----

    /** One pasted link (8.3): read now, answer with a draft to check and save. Nothing is saved as a product here. */
    async link({ url }, user) {
      await mustBeInPlan();
      const result = await judge(url, await newState());
      const answer = { status: result.status, itemId: null, productId: result.productId, readFrom: result.readFrom, reason: result.reason, message: IMPORT_REASONS[result.reason] ?? '', draft: toApiDraft(result.draft) };
      if (result.status === 'failed' || result.status === 'existing') return answer;
      const job = await imports.createJob({ kind: 'link', source: hostOf(result.draft?.externalUrl || canonicalProductUrl(url)), status: 'done', createdBy: user?.id });
      await imports.addItems(job.id, [{ line: 1, url: canonicalProductUrl(url), status: result.status, readFrom: result.readFrom, gatePassed: result.gatePassed, reason: result.reason ?? '', draft: result.draft }]);
      await imports.count(job.id);
      const [item] = await imports.items(job.id, { limit: 1 });
      return { ...answer, itemId: item.id };
    },

    /** Up to 25 links (8.6), each read and judged by the worker, with a report per link. */
    async bulk({ urls }, user) {
      await mustBeInPlan();
      if (urls.length > L.bulkLinks) throw invalidField('urls', IMPORT_REASONS.too_many_links);
      const job = await imports.createJob({ kind: 'bulk', source: `${urls.length} ${urls.length === 1 ? 'link' : 'links'}`, createdBy: user?.id });
      await imports.addItems(job.id, urls.map((url, index) => ({ line: index + 1, url: canonicalProductUrl(url) ?? url })));
      await imports.count(job.id);
      await enqueueRun({ jobId: job.id });
      return toJob(await imports.job(job.id));
    },

    /** A CSV file (8.6): a small one is imported at once, a larger one by the worker. A bad row never blocks the good ones. */
    async csv(file, user) {
      await mustBeInPlan();
      let parsed;
      try {
        parsed = readCsvFile(file.buffer);
      } catch (err) {
        if (err instanceof CatalogRuleError) throw invalidField('file', err.code === 'bad_row' ? 'The first line needs column names, such as title, url and price.' : err.message);
        throw err;
      }
      const job = await imports.createJob({ kind: 'csv', source: plainLine(file.originalname ?? 'file.csv', 120) || 'file.csv', createdBy: user?.id });
      for (let i = 0; i < parsed.rows.length; i += 500) {
        await imports.addItems(job.id, parsed.rows.slice(i, i + 500).map((row) => ({ line: row.line, url: row.cells.url ?? '', sku: row.cells.sku ?? '', draft: { cells: row.cells } })));
      }
      await imports.count(job.id);
      if (parsed.rows.length <= L.csvInlineRows) return toJob((await run({ jobId: job.id }, { inline: true })) ?? (await imports.job(job.id)));
      await enqueueRun({ jobId: job.id });
      return toJob(await imports.job(job.id));
    },

    /** A Shopify store's public product list (8.5), read by the worker with no keys. */
    async shopify({ storeUrl }, user) {
      await mustBeInPlan();
      const origin = storeOrigin(storeUrl);
      if (!origin) throw invalidField('storeUrl', 'Enter the store’s web address, like yourstore.com');
      const job = await imports.createJob({ kind: 'shopify', source: hostOf(origin), createdBy: user?.id });
      await enqueueRun({ jobId: job.id, origin, page: 1 });
      return toJob(job);
    },

    async list({ cursor, limit }) {
      const before = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await imports.jobs({ before, limit });
      const shown = rows.slice(0, limit);
      return { items: shown.map(toJob), nextCursor: rows.length > limit ? writeCursor([shown.at(-1).id]) : null };
    },

    async get(id) {
      const job = await imports.job(id);
      return job && toJob(job);
    },

    async items(id, { status, cursor, limit }) {
      const job = await imports.job(id);
      if (!job) return null;
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isInteger(key[0]) && key[0] >= 0)[0] : null;
      const rows = await imports.items(job.id, { status, after, limit });
      const shown = rows.slice(0, limit);
      return { items: shown.map(toItem), nextCursor: rows.length > limit ? writeCursor([shown.at(-1).line]) : null };
    },

    /** The adapters this business may use. */
    async enabledAdapters() {
      const enabled = await imports.enabledAdapters();
      return { items: adapters.list().filter((a) => enabled.includes(a.name)).map((a) => ({ ...a, enabled: true })) };
    },

    /**
     * Saves one item's draft as a product, with the owner's corrections over what was read (8.3). The owner has checked it,
     * so the quality gate doesn't apply (8.7). An item already saved, or an address the catalog already has, answers that product.
     */
    async save(id, body) {
      const item = await imports.item(id);
      if (!item) return null;
      if (item.product_id) return { productId: item.product_id };
      if (!['draft', 'refused'].includes(item.status)) throw new ApiError('conflict', 'There is nothing to save for this item.');
      const read = item.draft ?? {};
      let externalUrl = read.externalUrl || canonicalProductUrl(item.url) || '';
      if (body.externalUrl !== undefined) {
        externalUrl = body.externalUrl ? canonicalProductUrl(body.externalUrl) : '';
        if (externalUrl === null) throw invalidField('externalUrl', 'Use a web link starting with http:// or https://');
      }
      const done = async (productId, status) => {
        await imports.setItem(item.id, { status, productId });
        await imports.count(item.job_id);
        return { productId };
      };
      const existing = await catalog.idByExternalUrl(externalUrl);
      if (existing) return done(existing, 'existing');

      if (body.options !== undefined || body.variants !== undefined) {
        try {
          checkOptionsAndVariants(body.options ?? read.options ?? [], body.variants ?? []);
        } catch (err) {
          throw invalidField(body.variants?.length ? 'variants' : 'options', err.message);
        }
      }
      const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const edited = [];
      if (body.name !== read.name) edited.push('name');
      if (body.description !== undefined && body.description !== (read.description ?? '')) edited.push('description');
      if (body.images !== undefined && !same(body.images, read.images ?? [])) edited.push('images');
      if (body.categoryIds?.length) edited.push('categories');
      if (body.tags !== undefined && !same(body.tags, read.tags ?? [])) edited.push('tags');
      if (body.options !== undefined && !same(body.options, read.options ?? [])) edited.push('options');
      const draft = {
        name: body.name,
        description: body.description ?? read.description ?? '',
        pricePaise: body.pricePaise,
        mrpPaise: body.mrpPaise !== undefined ? body.mrpPaise : read.mrpPaise ?? null,
        inStock: body.inStock ?? (body.stock === 0 ? false : read.inStock ?? true),
        images: body.images ?? read.images ?? [],
        tags: body.tags ?? read.tags ?? [],
        options: body.options ?? (body.variants !== undefined ? [] : read.options ?? []),
        variants: body.variants ?? (body.options !== undefined ? [] : read.variants ?? []),
        externalUrl,
        sku: read.sku ?? '',
      };
      const source = externalUrl ? read.source ?? 'link' : 'manual';
      let productId;
      try {
        productId = await createFromDraft(catalog, draft, {
          source,
          sourceRef: source === 'manual' ? '' : read.sourceRef ?? '',
          priceManual: read.pricePaise === null || read.pricePaise === undefined || body.pricePaise !== read.pricePaise,
          recheckHours: await catalog.recheckHours(),
          categoryIds: body.categoryIds ?? [],
          active: body.active ?? true,
        });
      } catch (err) {
        const clash = violated(err, 'products_external_url_idx') ? await catalog.idByExternalUrl(externalUrl) : violated(err, 'products_source_ref_idx') ? await catalog.idBySourceRef(source, read.sourceRef) : null;
        if (clash) return done(clash, 'existing');
        if (violated(err, 'product_variants_sku_idx')) throw invalidField('variants', 'That SKU is already used by another product');
        throw err;
      }
      const extra = {};
      if (edited.length) extra.owner_edited = edited;
      if (body.featured) extra.featured = true;
      if (body.whatsappOrder !== undefined) extra.whatsapp_order = body.whatsappOrder;
      if (typeof body.stock === 'number' && body.stock > 0 && draft.inStock) extra.stock = body.stock;
      if (Object.keys(extra).length || body.imageAlts) await catalog.update(productId, extra, body.imageAlts ? { gallery: { alts: body.imageAlts } } : {});
      // The owner is waiting on this one product, so its image is copied now; if that fails the original address stays (8.3).
      await copyFirstImage(productId).catch((err) => {
        if (!(err instanceof SafeFetchError)) reportError(err, { msg: 'imports.image_failed', tenantId: tenantId(), productId });
      });
      return done(productId, 'created');
    },
  };
}
