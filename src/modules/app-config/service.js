import { APP_PLATFORMS } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { APP_LINK_PATHS, BrandFile, appFeatureOf, brandFileProblems, checkAsset, namesPlatform } from '../../contracts/apps.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { appReviewCodeHash } from '../app-api/sessions.js';
import { measureImage } from '../app-builds/images.js';
import { writeAudit } from '../audit/index.js';
import { fallbackHost } from '../domains/rules.js';

/**
 * The business's own app details (PRD 10.7, 10.8): one app_configs row over the brand kit. See index.js for the interface.
 *
 * Every statement names tenant_id = tenantId(), so a call only ever reads or writes the current business's row. Seller text
 * (the app's name, its short name, its addresses) is checked here for markup, control characters, the platform's name and the
 * stores' lengths, and is only ever written into a build as a JSON value of the brand file: never a shell argument, a path or
 * code. The ids the stores know the app by (package, bundle id, link scheme) are unique across every business (the database's
 * unique indexes, answered as a 409 here) and locked after the first submitted build (checked here, and by app_configs_locked).
 */

/** Route field -> app_configs column, for every field a seller may change. The only column names that reach SQL from a save. */
const COLUMNS = Object.freeze({
  appName: 'app_name', shortName: 'short_name', androidPackage: 'android_package', iosBundleId: 'ios_bundle_id', urlScheme: 'url_scheme',
  iconMediaId: 'icon_media_id', splashMediaId: 'splash_media_id', splashBackground: 'splash_background', colors: 'colors',
  headingFont: 'heading_font', bodyFont: 'body_font', shopDomain: 'shop_domain', supportEmail: 'support_email', privacyUrl: 'privacy_url',
  appleTeamId: 'apple_team_id', playAccountId: 'play_account_id', playSigningSha256: 'play_signing_sha256',
});
const MIN_COLUMNS = Object.freeze({ android: ['android_min_version', 'android_store_url'], ios: ['ios_min_version', 'ios_store_url'] });
const STORE_URL = Object.freeze({ android: /^https:\/\/play\.google\.com\/store\/apps\/details\?id=\S+$/, ios: /^https:\/\/apps\.apple\.com\/\S+$/ });
/** The five images of every brand file, by the names the build writes them under. Constants: no seller text is ever a file name. */
export const BRAND_ASSET_FILES = Object.freeze({
  icon: 'icon.png', adaptiveForeground: 'adaptive-foreground.png', adaptiveBackground: 'adaptive-background.png', notificationIcon: 'notification.png', splash: 'splash.png',
});
/** Schemes a phone already gives to something else: an app may not claim them as its link name. */
const RESERVED_SCHEMES = new Set(['http', 'https', 'javascript', 'data', 'file', 'ftp', 'mailto', 'tel', 'sms', 'smsto', 'mms', 'intent', 'content',
  'about', 'blob', 'ws', 'wss', 'market', 'itms', 'itmsapps', 'geo', 'maps', 'facetime', 'whatsapp', 'instagram', 'fb', 'expo', 'exp', 'android', 'ios', 'app', 'shop']);
const HEX = /^#[0-9A-Fa-f]{6}$/;
const COLOR_KEY = /^[a-z_]{1,20}$/;
/** NUL and other control characters, and a lone half of a surrogate pair: text the database or a build file cannot hold. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const MARKUP = /[<>]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_APP = 'Your plan doesn’t include your own shopper app.';

/** A brand file or a build that cannot be made from these details. `problems` are AppValidation problems; `field` the first one's. */
export class AppConfigProblem extends ValidationError {
  constructor(problems) {
    super(problems[0]?.message ?? 'Check your app details.');
    this.name = 'AppConfigProblem';
    this.problems = problems;
    this.field = problems[0]?.field ?? null;
    this.code = problems[0]?.code ?? 'invalid';
  }
}

const problem = (field, code, message, platform = null) => ({ field, code, message, platform });
/** Only colour keys and #RRGGBB values: what a brand file's colours may hold. */
function plainColors(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, color] of Object.entries(value)) if (COLOR_KEY.test(key) && HEX.test(String(color))) out[key] = String(color).toUpperCase();
  return out;
}
/** The text checks the shared brandFileProblems does not make: markup and control characters in names, a link name a phone keeps. */
export function textProblems(config) {
  const problems = [];
  for (const field of ['appName', 'shortName']) {
    const value = String(config[field] ?? '');
    if (UNSAFE_TEXT.test(value)) problems.push(problem(field, 'invalid', 'Use plain letters, digits and punctuation, with no hidden characters.'));
    else if (MARKUP.test(value)) problems.push(problem(field, 'markup', 'Use plain text: the stores show the name as it is, so leave out < and >.'));
  }
  const scheme = String(config.urlScheme ?? '');
  if (scheme && RESERVED_SCHEMES.has(scheme)) problems.push(problem('urlScheme', 'reserved', 'That link name is taken by the phone itself. Choose one made from your brand’s name.'));
  return problems;
}

/** The problems of a seller's save that are refused before anything is written (400), each naming its field. */
function saveProblems(patch) {
  const problems = [];
  for (const [field, value] of Object.entries(patch)) {
    const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value.map(String) : [];
    if (texts.some((t) => UNSAFE_TEXT.test(t))) problems.push(problem(field, 'invalid', 'Use plain text, with no hidden characters.'));
    else if (texts.some((t) => namesPlatform(t))) problems.push(problem(field, 'names_platform', 'Use your own brand here, not the platform’s name.'));
  }
  for (const p of textProblems(patch)) if (!problems.some((q) => q.field === p.field)) problems.push(p);
  if (patch.privacyUrl) {
    try {
      const url = new URL(patch.privacyUrl);
      if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password) throw new Error('bad');
    } catch {
      problems.push(problem('privacyUrl', 'invalid', 'Use the full https:// link of your privacy policy page.'));
    }
  }
  if (patch.colors && Object.values(patch.colors).some((c) => !HEX.test(String(c)))) problems.push(problem('colors', 'invalid', 'Use colours like #234D33.'));
  return problems;
}

const refuse = (problems, code = 'validation_failed') => new ApiError(code, problems.map((p) => p.message).join(' '), { fields: Object.fromEntries(problems.map((p) => [p.field, p.message])) });

export function createAppConfig(ctx) {
  const { db, repos, config } = ctx;
  const tid = () => tenantId();

  async function row() {
    const [found] = await db.query('SELECT * FROM app_configs WHERE tenant_id = $1', [tid()]);
    return found ?? null;
  }

  async function entitledPlatforms() {
    const out = [];
    for (const platform of APP_PLATFORMS) if (await repos.entitlements.can(appFeatureOf(platform))) out.push(platform);
    return out;
  }

  async function requireApp() {
    const entitled = await entitledPlatforms();
    if (!entitled.length) throw new ApiError('forbidden', NO_APP);
    return entitled;
  }

  async function kitOf() {
    try {
      return (await repos.brandKit.get()) ?? {};
    } catch {
      return {};
    }
  }

  function shape(r, kit, entitled) {
    const c = r ?? {};
    const overrides = plainColors(c.colors);
    const platformState = (platform) => ({
      entitled: entitled.includes(platform),
      minVersion: c[MIN_COLUMNS[platform][0]] ?? '',
      storeUrl: c[MIN_COLUMNS[platform][1]] ?? '',
      locked: Boolean(c[`${platform}_locked_at`]),
    });
    const validation = c.validation && typeof c.validation.ok === 'boolean' && Array.isArray(c.validation.problems) ? c.validation : null;
    return {
      appName: c.app_name ?? '',
      shortName: c.short_name ?? '',
      androidPackage: c.android_package ?? null,
      iosBundleId: c.ios_bundle_id ?? null,
      urlScheme: c.url_scheme ?? null,
      iconMediaId: c.icon_media_id ?? null,
      iconUrl: c.icon_media_id ? `/media/${c.icon_media_id}` : '',
      splashMediaId: c.splash_media_id ?? null,
      splashUrl: c.splash_media_id ? `/media/${c.splash_media_id}` : '',
      splashBackground: c.splash_background ?? '',
      colors: { ...plainColors(kit?.colors), ...overrides },
      colorOverrides: overrides,
      headingFont: c.heading_font || kit?.headingFont || '',
      bodyFont: c.body_font || kit?.bodyFont || '',
      fontOverrides: { heading: c.heading_font ?? '', body: c.body_font ?? '' },
      shopDomain: c.shop_domain ?? '',
      supportEmail: c.support_email ?? '',
      privacyUrl: c.privacy_url ?? '',
      appleTeamId: c.apple_team_id ?? '',
      playAccountId: c.play_account_id ?? '',
      playSigningSha256: Array.isArray(c.play_signing_sha256) ? c.play_signing_sha256 : [],
      android: platformState('android'),
      ios: platformState('ios'),
      validation: validation ? { ok: validation.ok, checkedAt: validation.checkedAt, problems: validation.problems } : null,
    };
  }

  /** The details as the route shows them, with no plan check: for the build pipeline, which checks the plan itself. */
  async function read() {
    const [r, kit, entitled] = await Promise.all([row(), kitOf(), entitledPlatforms()]);
    return shape(r, kit, entitled);
  }

  /** This business's own addresses: its verified domains and its address under the platform's domain, lower case. */
  async function hosts() {
    const id = tid();
    const [tenant] = await db.query('SELECT slug FROM tenants WHERE id = $1', [id]);
    const domains = await db.query(`SELECT domain FROM tenant_domains WHERE tenant_id = $1 AND status = 'verified' ORDER BY domain`, [id]);
    const all = [...domains.map((d) => d.domain), tenant ? fallbackHost(tenant, config ?? {}) : ''];
    return [...new Set(all.filter(Boolean).map((h) => String(h).toLowerCase()))];
  }

  /** The icon and splash, measured against the stores' specs: [problem]. A missing or unreadable file names its field. */
  async function imageProblems(details) {
    const problems = [];
    for (const [field, id] of [['iconMediaId', details.iconMediaId], ['splashMediaId', details.splashMediaId]]) {
      if (!id) continue;
      const what = field === 'iconMediaId' ? 'app icon' : 'splash image';
      const media = await repos.media.get(id).catch(() => null);
      if (!media?.data?.length) {
        problems.push(problem(field, 'missing', `Upload the ${what} again: the file is gone.`));
        continue;
      }
      const measured = await measureImage(media.data).catch(() => null);
      if (!measured) {
        problems.push(problem(field, 'not_image', `The ${what} is not an image we can read. Upload a PNG or JPEG.`));
        continue;
      }
      if (field === 'iconMediaId') {
        for (const p of checkAsset('source_icon', measured)) problems.push(problem(field, p.code, p.message));
      } else if (!['image/png', 'image/jpeg'].includes(measured.mime)) {
        problems.push(problem(field, 'wrong_type', 'The splash image must be a PNG or JPEG file.'));
      } else if (Math.min(measured.width, measured.height) < 512) {
        problems.push(problem(field, 'too_small', `The splash image must be at least 512 pixels on each side; this one is ${measured.width} x ${measured.height}.`));
      }
    }
    return problems;
  }

  /** Every problem that stops a build of `platforms`, each once, naming its field. */
  async function problemsFor(details, kit, platforms) {
    const found = [...brandFileProblems(details, kit, { platforms, hosts: await hosts() }), ...textProblems(details), ...(await imageProblems(details))];
    const seen = new Set();
    return found.filter((p) => {
      const key = `${p.field}:${p.code}:${p.platform}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function get() {
    await requireApp();
    return read();
  }

  async function save(patch, actor) {
    await requireApp();
    const fields = Object.keys(patch ?? {}).filter((key) => Object.hasOwn(COLUMNS, key));
    if (!fields.length) return read();
    const values = Object.fromEntries(fields.map((f) => [f, typeof patch[f] === 'string' ? patch[f].trim() : patch[f]]));
    const refused = saveProblems(values);
    if (refused.length) throw refuse(refused);

    const current = await row();
    // The ids the stores know the app by never change after its first submitted build (app_configs_locked is the second lock).
    const locked = [];
    if (current?.android_locked_at && 'androidPackage' in values && values.androidPackage !== current.android_package) locked.push(problem('androidPackage', 'locked', 'The Android package can’t change after your app was sent to Google Play.'));
    if (current?.ios_locked_at && 'iosBundleId' in values && values.iosBundleId !== current.ios_bundle_id) locked.push(problem('iosBundleId', 'locked', 'The iOS bundle ID can’t change after your app was sent to the App Store.'));
    if ((current?.android_locked_at || current?.ios_locked_at) && 'urlScheme' in values && values.urlScheme !== current.url_scheme) locked.push(problem('urlScheme', 'locked', 'The app’s link name can’t change after your app was sent to a store.'));
    if (locked.length) throw refuse(locked, 'conflict');

    // The icon and splash are this business's own uploads, held to the stores' specs before they are kept.
    for (const field of ['iconMediaId', 'splashMediaId']) {
      if (!values[field]) continue;
      if (!UUID.test(values[field])) throw refuse([problem(field, 'invalid', 'Upload the image first.')]);
      const [media] = await db.query('SELECT id FROM media WHERE tenant_id = $1 AND id = $2', [tid(), values[field]]);
      if (!media) throw refuse([problem(field, 'missing', 'Upload the image first.')]);
    }
    const images = await imageProblems({ iconMediaId: values.iconMediaId, splashMediaId: values.splashMediaId });
    if (images.length) throw refuse(images);

    const cols = fields.map((f) => COLUMNS[f]);
    const params = fields.map((f) => (f === 'colors' ? JSON.stringify(plainColors(values.colors ?? {})) : f === 'playSigningSha256' ? values[f] ?? [] : values[f] ?? null));
    const id = tid();
    try {
      await db.tx(async (t) => {
        await t.query(
          `INSERT INTO app_configs (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
           ON CONFLICT (tenant_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, validation = '{}', validated_at = NULL, updated_at = now()`,
          [id, ...params],
        );
        await writeAudit(t, { actor, action: 'app.config_saved', target: 'app_config', details: { fields } });
      });
    } catch (err) {
      throw saveFailure(err) ?? err;
    }
    return read();
  }

  /** A database refusal of a save, as the seller's answer; null for a real fault. */
  function saveFailure(err) {
    const text = `${err?.constraint ?? ''} ${err?.message ?? ''}`;
    if (err?.code === '23505') {
      if (/package/.test(text)) return refuse([problem('androidPackage', 'taken', 'That Android package is already used by another app. Choose one made from your brand’s name.')], 'conflict');
      if (/bundle/.test(text)) return refuse([problem('iosBundleId', 'taken', 'That iOS bundle ID is already used by another app. Choose one made from your brand’s name.')], 'conflict');
      if (/scheme/.test(text)) return refuse([problem('urlScheme', 'taken', 'That link name is already used by another app. Choose one made from your brand’s name.')], 'conflict');
      return new ApiError('conflict', 'That is already used by another app.');
    }
    if (/app_configs_locked/.test(text)) return new ApiError('conflict', 'The app’s store ids can’t change after it was sent to a store.');
    if (err?.code === '23514' || err?.code === '23503') return new ApiError('validation_failed', 'Check your app details and try again.');
    return null;
  }

  /** The problems validate() would find for `platforms`, without storing them or checking the plan (for the pipeline). */
  async function check(platforms) {
    const [details, kit] = await Promise.all([read(), kitOf()]);
    return problemsFor(details, kit, platforms);
  }

  async function validate({ platforms } = {}) {
    const entitled = await requireApp();
    const list = platforms?.length ? platforms.filter((p) => APP_PLATFORMS.includes(p)) : entitled;
    const [details, kit] = await Promise.all([read(), kitOf()]);
    const problems = await problemsFor(details, kit, list);
    const result = { ok: problems.length === 0, checkedAt: new Date().toISOString(), problems };
    await db.query('UPDATE app_configs SET validation = $2, validated_at = now() WHERE tenant_id = $1', [tid(), JSON.stringify(result)]);
    return result;
  }

  /**
   * The brand file of one build of `platform`, checked against BrandFile. Throws an AppConfigProblem naming the field when the
   * details cannot make one (P-33). It carries no key, token, password or fingerprint of a signing key, and nothing of any
   * other business: every value is this business's own row, its brand kit and its own hosts.
   */
  async function brandFile({ platform, buildNumber, appVersion, runtimeVersion }) {
    if (!APP_PLATFORMS.includes(platform)) throw new AppConfigProblem([problem('platform', 'invalid', 'Build for android or ios.')]);
    const [details, kit] = await Promise.all([read(), kitOf()]);
    const problems = await problemsFor(details, kit, [platform]);
    if (problems.length) throw new AppConfigProblem(problems);
    const id = tid();
    const domain = String(details.shopDomain).toLowerCase();
    const colors = plainColors(details.colors);
    const brand = {
      schema: 1,
      tenantId: id,
      name: details.appName.trim(),
      shortName: details.shortName.trim(),
      scheme: details.urlScheme,
      appVersion,
      runtimeVersion,
      shopDomain: domain,
      apiBaseUrl: `https://${domain}`,
      supportEmail: details.supportEmail,
      privacyUrl: details.privacyUrl,
      android: platform === 'android' ? { package: details.androidPackage, versionCode: buildNumber } : null,
      ios: platform === 'ios' ? { bundleId: details.iosBundleId, buildNumber, teamId: details.appleTeamId } : null,
      associatedDomains: platform === 'ios' ? [`applinks:${domain}`] : [],
      linkHosts: [domain],
      linkPaths: { open: [...APP_LINK_PATHS.open], exclude: [...APP_LINK_PATHS.exclude] },
      colors,
      fonts: { heading: details.headingFont || '', body: details.bodyFont || '' },
      splashBackground: HEX.test(details.splashBackground) ? details.splashBackground.toUpperCase() : colors.ground ?? '#FFFFFF',
      assets: { ...BRAND_ASSET_FILES },
      payDriver: 'hosted',
      push: await pushFlags(),
      updates: { channel: `t${id}` },
    };
    const parsed = BrandFile.safeParse(brand);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue.path[0] ?? 'brand');
      throw new AppConfigProblem([problem(field, 'invalid', `${field}: ${issue.message}`)]);
    }
    return parsed.data;
  }

  /** Whether the brand's own push keys are set, from the shopper push module; off when it cannot say. */
  async function pushFlags() {
    try {
      const { shopperPushFor } = await import('../shopper-push/index.js');
      const keys = await shopperPushFor(ctx).credentials.get();
      return { android: Boolean(keys?.fcm?.set && keys.fcm.status !== 'invalid'), ios: Boolean(keys?.apns?.set && keys.apns.status !== 'invalid') };
    } catch {
      return { android: false, ios: false };
    }
  }

  async function minimums() {
    const r = await row();
    return {
      android: { minVersion: r?.android_min_version ?? '', storeUrl: r?.android_store_url ?? '' },
      ios: { minVersion: r?.ios_min_version ?? '', storeUrl: r?.ios_store_url ?? '' },
    };
  }

  /** Our team's: the oldest app version that still works, and where to get a newer one. Mirrored into app_min_versions (601). */
  async function setMinimum({ platform, minVersion = '', storeUrl = '' }, actor = 'system') {
    if (!APP_PLATFORMS.includes(platform)) throw new ValidationError('Choose android or ios.');
    if (storeUrl && !STORE_URL[platform].test(storeUrl)) throw new ValidationError(platform === 'ios' ? 'Use the app’s App Store link.' : 'Use the app’s Google Play link.');
    const [minCol, urlCol] = MIN_COLUMNS[platform];
    await db.tx(async (t) => {
      await t.query(
        `INSERT INTO app_configs (tenant_id, ${minCol}, ${urlCol}) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET ${minCol} = EXCLUDED.${minCol}, ${urlCol} = EXCLUDED.${urlCol}, updated_at = now()`,
        [tid(), minVersion, storeUrl],
      );
      await writeAudit(t, { actor, action: 'app.minimum_set', target: `app_config:${platform}`, details: { platform, minVersion, storeUrlSet: Boolean(storeUrl) } });
    });
    return minimums();
  }

  /** The store link alone, as the store gives it once the app is live. */
  async function setStoreUrl(platform, url) {
    if (!APP_PLATFORMS.includes(platform)) throw new ValidationError('Choose android or ios.');
    if (url && !STORE_URL[platform].test(url)) throw new ValidationError('That is not the app’s store link.');
    const urlCol = MIN_COLUMNS[platform][1];
    await db.query(
      `INSERT INTO app_configs (tenant_id, ${urlCol}) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET ${urlCol} = EXCLUDED.${urlCol}, updated_at = now()`,
      [tid(), url ?? ''],
    );
    return minimums();
  }

  /** Demo access for store review (2.1(a)): the number and only the keyed hash of its code. The code is never stored or logged. */
  async function setReviewAccess({ phone = null, code = null, enabled }, actor = 'system') {
    if ((phone && !code) || (!phone && code)) throw new ValidationError('Give the review number and its code together.');
    if (enabled && !phone) {
      const current = await row();
      if (!current?.review_phone || !current?.review_code_hash) throw new ValidationError('Give the review number and its code to turn review access on.');
    }
    const id = tid();
    const hash = phone && code ? appReviewCodeHash(config, { tenantId: id, phone, code }) : null;
    await db.tx(async (t) => {
      if (phone) {
        await t.query(
          `INSERT INTO app_configs (tenant_id, review_phone, review_code_hash, review_enabled) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id) DO UPDATE SET review_phone = EXCLUDED.review_phone, review_code_hash = EXCLUDED.review_code_hash, review_enabled = EXCLUDED.review_enabled, updated_at = now()`,
          [id, phone, hash, Boolean(enabled)],
        );
      } else {
        await t.query(
          `INSERT INTO app_configs (tenant_id, review_enabled) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET review_enabled = EXCLUDED.review_enabled, updated_at = now()`,
          [id, Boolean(enabled)],
        );
      }
      await writeAudit(t, { actor, action: 'app.review_access_set', target: 'app_config', details: { enabled: Boolean(enabled), numberChanged: Boolean(phone) } });
    });
  }

  return { get, read, save, validate, check, brandFile, hosts, entitledPlatforms, requireApp, imageProblems, setMinimum, setStoreUrl, setReviewAccess, minimums, row };
}
