import crypto from 'node:crypto';
import sharp from 'sharp';
import { APP_ENTITLEMENTS, DATA_COLLECTED, assetSpecKey, checkAsset, listingLimits, listingProblems, namesPlatform, storeOf } from '../../contracts/apps.js';
import { ApiError } from '../../contracts/api/errors.js';
import { StoreListingUpdate } from '../../contracts/api/apps.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';

/**
 * What each store shows (PRD 10.13). See index.js for the interface.
 *
 * The text starts from a template that names the business (its app name, or its business name) and the owner edits it; every
 * save runs listingProblems for that store and is refused whole, naming the field, the store's limit and the length, when any
 * field is over or names the platform. The data safety answers (Play) and the privacy labels (App Store) are built from
 * DATA_COLLECTED on every read and save, so they always say what the app collects: nothing tracks, and payment details are the
 * gateway's and are not listed. Images live in private storage under t/<business>/listing/ and are answered by a link carrying
 * a keyed signature of the file, on the business's own address only.
 */
const FIELDS = Object.freeze({ title: 'title', shortDescription: 'short_description', fullDescription: 'full_description', keywords: 'keywords', category: 'category', whatsNew: 'whats_new' });
const KINDS = Object.freeze(['icon', 'adaptive_foreground', 'adaptive_background', 'notification_icon', 'splash', 'feature_graphic', 'screenshot']);
const DEVICES = Object.freeze({ android: ['phone'], ios: ['iphone_6_9', 'iphone_6_5'] });
const SOURCES = Object.freeze(['generated', 'build_capture', 'upload']);
const PURPOSE_WORDS = Object.freeze({ app_functionality: 'App functionality' });
const services = new WeakMap();

const cut = (text, limit) => {
  const chars = [...String(text)];
  if (chars.length <= limit) return String(text);
  const short = chars.slice(0, limit).join('');
  return short.slice(0, Math.max(short.lastIndexOf(' '), 1)).replace(/[\s,.;:-]+$/, '');
};

/** Google Play's data safety answers, from what the app collects. */
export function dataSafetyOf(collected = DATA_COLLECTED) {
  return {
    collectsData: collected.length > 0,
    sharesData: false,
    encryptedInTransit: true,
    deletionRequestAvailable: true,
    dataTypes: collected.map((d) => ({ type: d.type, purposes: [...d.purposes], purposeLabels: d.purposes.map((p) => PURPOSE_WORDS[p] ?? p), optional: d.optional, shared: false, ephemeral: false })),
  };
}

/** The App Store's privacy labels, from what the app collects. */
export function privacyLabelsOf(collected = DATA_COLLECTED) {
  return {
    tracking: false,
    dataUsedToTrackYou: [],
    dataLinkedToYou: collected.filter((d) => d.linked).map((d) => ({ type: d.type, purposes: [...d.purposes] })),
    dataNotLinkedToYou: collected.filter((d) => !d.linked).map((d) => ({ type: d.type, purposes: [...d.purposes] })),
  };
}

/** The owner-editable starting text for one store, naming the business. A name that names the platform is left out. */
export function listingTemplate(platform, businessName) {
  const name = namesPlatform(businessName) ? '' : String(businessName ?? '').trim();
  const limits = listingLimits(platform);
  const title = cut(name, limits.title);
  const short = platform === 'ios' ? `Shop ${name}` : `Shop ${name} on your phone: new arrivals, reels and easy orders`;
  return {
    title,
    shortDescription: name ? cut(short, limits.shortDescription) : '',
    fullDescription: name ? cut(`${name}, in your pocket. Browse the full ${name} range, watch the newest reels, and order in a few taps. Track every delivery, keep your addresses, pay securely, and hear about offers only if you turn them on.`, limits.fullDescription) : '',
    keywords: platform === 'ios' && name ? cut(`${name.toLowerCase()},shop,shopping,orders,offers,new arrivals`, limits.keywords) : '',
    category: 'Shopping',
    whatsNew: '',
  };
}

const signature = (secret, tid, row) => crypto.createHmac('sha256', String(secret)).update(`listing-asset:${tid}:${row.id}:${row.sha256}`).digest('base64url').slice(0, 32);

export function storeListingsFor(ctx) {
  let found = services.get(ctx);
  if (!found) services.set(ctx, (found = createStoreListings(ctx)));
  return found;
}

function createStoreListings(ctx) {
  const { db, config, platform: drivers } = ctx;

  async function requireApp(platform) {
    if (!['android', 'ios'].includes(platform)) throw new ApiError('not_found');
    if (!(await ctx.repos.entitlements.can(APP_ENTITLEMENTS[platform]))) throw new ApiError('forbidden', 'Your plan doesn’t include your own app on this store.', { reason: 'plan' });
  }

  async function businessName() {
    const [row] = await db.query(`SELECT COALESCE(NULLIF(c.app_name, ''), t.name) AS name FROM tenants t LEFT JOIN app_configs c ON c.tenant_id = t.id WHERE t.id = $1`, [tenantId()]);
    return row?.name ?? '';
  }

  const rowOf = async (platform, runner = db) => (await runner.query(`SELECT * FROM store_listings WHERE tenant_id = $1 AND platform = $2 AND locale = 'en-IN'`, [tenantId(), platform]))[0] ?? null;

  function textOf(row) {
    return Object.fromEntries(Object.entries(FIELDS).map(([field, column]) => [field, row[column] ?? '']));
  }

  function view(platform, text, validation) {
    return {
      platform, ...text,
      limits: listingLimits(platform),
      dataSafety: platform === 'android' ? dataSafetyOf() : {},
      privacyLabels: platform === 'ios' ? privacyLabelsOf() : {},
      validation,
    };
  }

  const validationOf = (platform, text) => ({ ok: true, checkedAt: new Date(), problems: listingProblems(platform, text).map((p) => ({ field: p.field, code: p.code, message: p.message, platform })) });

  async function template(platform) {
    return listingTemplate(platform, await businessName());
  }

  async function get(platform) {
    await requireApp(platform);
    const row = await rowOf(platform);
    if (row) return view(platform, textOf(row), row.validated_at ? { ok: row.validation?.ok === true, checkedAt: row.validated_at, problems: row.validation?.problems ?? [] } : null);
    const text = await template(platform);
    const validation = validationOf(platform, text);
    return view(platform, text, { ...validation, ok: validation.problems.length === 0 });
  }

  async function save(platform, patch, user) {
    await requireApp(platform);
    const parsed = StoreListingUpdate.safeParse(patch ?? {});
    if (!parsed.success) throw new ApiError('validation_failed', parsed.error.issues[0]?.message ?? 'Check the details and try again.');
    const current = await rowOf(platform);
    const text = { ...(current ? textOf(current) : await template(platform)), ...parsed.data };
    const problems = listingProblems(platform, text);
    if (problems.length) {
      const fields = {};
      for (const p of problems) fields[p.field] ??= p.message;
      throw new ApiError('validation_failed', problems.map((p) => p.message).join(' '), { fields });
    }
    const validation = { ok: true, checkedAt: new Date().toISOString(), problems: [] };
    const actorId = Number.isSafeInteger(Number(user?.id)) ? Number(user.id) : null;
    const saved = await db.tx(async (t) => {
      const columns = Object.values(FIELDS);
      const values = Object.keys(FIELDS).map((field) => text[field]);
      const [row] = await t.query(
        `INSERT INTO store_listings (tenant_id, platform, locale, ${columns.join(', ')}, data_safety, privacy_labels, validation, validated_at, updated_by)
         VALUES ($1, $2, 'en-IN', ${columns.map((_, i) => `$${i + 3}`).join(', ')}, $9, $10, $11, now(), (SELECT id FROM users WHERE tenant_id = $1 AND id = $12))
         ON CONFLICT (tenant_id, platform, locale) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, data_safety = EXCLUDED.data_safety,
           privacy_labels = EXCLUDED.privacy_labels, validation = EXCLUDED.validation, validated_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [tenantId(), platform, ...values, JSON.stringify(platform === 'android' ? dataSafetyOf() : {}), JSON.stringify(platform === 'ios' ? privacyLabelsOf() : {}), JSON.stringify(validation), actorId],
      );
      await writeAudit(t, { actor: actorId ? `user:${actorId}` : 'user:unknown', action: 'store_listing.saved', target: `store_listing:${platform}`, details: { platform, fields: Object.keys(parsed.data) } });
      return row;
    });
    log.info('store_listings.saved', { tenantId: tenantId(), platform });
    return view(platform, textOf(saved), { ok: true, checkedAt: saved.validated_at, problems: [] });
  }

  const assetView = (row) => ({
    kind: row.kind, device: row.device, position: row.position, url: `/app-listing-assets/${row.id}/${signature(config.sessionSecret, tenantId(), row)}`,
    width: row.width, height: row.height, source: row.source, specOk: row.spec_ok, problems: Array.isArray(row.spec_problems) ? row.spec_problems : [],
  });

  async function assets(platform) {
    await requireApp(platform);
    const rows = await db.query('SELECT * FROM listing_assets WHERE tenant_id = $1 AND platform = $2 ORDER BY kind, device, position', [tenantId(), platform]);
    return rows.map(assetView);
  }

  /**
   * Stores one image of the listing: checked against its spec (checkAsset) with its real size and type, kept in private storage.
   * meta: { device?, position?, source, buildId?, monochrome? }. A screenshot must come from the real build (source build_capture).
   */
  async function putAsset(platform, kind, file, meta = {}) {
    if (!storeOf(platform)) throw new ApiError('not_found');
    if (!KINDS.includes(kind)) throw new ApiError('validation_failed', 'This is not an image the stores take.');
    const device = kind === 'screenshot' ? String(meta.device ?? '') : '';
    if (kind === 'screenshot' && !DEVICES[platform].includes(device)) throw new ApiError('validation_failed', 'Say which device the screenshot is for.');
    const position = Number(meta.position ?? 0);
    if (!Number.isInteger(position) || position < 0 || position > 9) throw new ApiError('validation_failed', 'A listing holds at most ten of each image.');
    const source = String(meta.source ?? 'generated');
    if (!SOURCES.includes(source)) throw new ApiError('validation_failed', 'Say where the image came from.');
    if (kind === 'screenshot' && source !== 'build_capture') throw new ApiError('validation_failed', 'Screenshots come from the real build, never a mock-up.');
    const buffer = Buffer.from(file ?? []);
    let info;
    try {
      info = await sharp(buffer).metadata();
    } catch {
      throw new ApiError('unsupported_media_type', 'This file is not a PNG or JPEG image.');
    }
    const mime = info.format === 'png' ? 'image/png' : info.format === 'jpeg' ? 'image/jpeg' : null;
    if (!mime) throw new ApiError('unsupported_media_type', 'This file is not a PNG or JPEG image.');
    const specKey = assetSpecKey(platform, kind, device);
    const problems = checkAsset(specKey, { width: info.width, height: info.height, mime, hasAlpha: Boolean(info.hasAlpha), bytes: buffer.length, monochrome: meta.monochrome });
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const key = `t/${tenantId()}/listing/${platform}/${kind}${device ? `-${device}` : ''}-${position}-${sha.slice(0, 16)}.${mime === 'image/png' ? 'png' : 'jpg'}`;
    await drivers.storage.put(key, buffer, mime);
    const before = (await db.query('SELECT storage_key FROM listing_assets WHERE tenant_id = $1 AND platform = $2 AND kind = $3 AND device = $4 AND position = $5', [tenantId(), platform, kind, device, position]))[0];
    const buildId = Number.isSafeInteger(Number(meta.buildId)) && Number(meta.buildId) > 0 ? Number(meta.buildId) : null;
    const [row] = await db.query(
      `INSERT INTO listing_assets (tenant_id, platform, kind, device, position, storage_key, width, height, mime, bytes, sha256, source, build_id, spec_ok, spec_problems)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, (SELECT id FROM app_builds WHERE tenant_id = $1 AND id = $13), $14, $15)
       ON CONFLICT (tenant_id, platform, kind, device, position) DO UPDATE SET storage_key = EXCLUDED.storage_key, width = EXCLUDED.width, height = EXCLUDED.height,
         mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, source = EXCLUDED.source, build_id = EXCLUDED.build_id, spec_ok = EXCLUDED.spec_ok,
         spec_problems = EXCLUDED.spec_problems, created_at = now()
       RETURNING *`,
      [tenantId(), platform, kind, device, position, key, info.width, info.height, mime, buffer.length, sha, source, buildId, problems.length === 0, JSON.stringify(problems)],
    );
    if (before && before.storage_key !== key) await drivers.storage.remove(before.storage_key).catch(() => {});
    return assetView(row);
  }

  /** The file behind an asset link of this business, or null when the link is not one we made. */
  async function assetFile(id, sig) {
    if (!/^[1-9][0-9]{0,17}$/.test(String(id)) || !/^[A-Za-z0-9_-]{32}$/.test(String(sig))) return null;
    const [row] = await db.query('SELECT * FROM listing_assets WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
    if (!row) return null;
    const want = Buffer.from(signature(config.sessionSecret, tenantId(), row));
    const got = Buffer.from(String(sig));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const body = await drivers.storage.get(row.storage_key);
    return body ? { body, mime: row.mime } : null;
  }

  return { get, save, assets, putAsset, template, assetFile, requireApp };
}
