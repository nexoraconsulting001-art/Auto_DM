import { ApiError } from '../../contracts/api/index.js';
import { IMPORT_REASONS, PLAN_REASON } from '../../contracts/catalog.js';
import { resolveSlots } from '../../contracts/themes.js';
import { SafeFetchError } from '../../platform/safe-fetch.js';
import { log } from '../../platform/log.js';
import { invalidField } from '../admin-api/errors.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { COLOR_KEYS, isHexColor } from '../brand/theme.js';
import { dominantColor, tuneAccent } from './accent.js';
import { extractLook, lookColors } from './site-read.js';

/**
 * A business's look (PRD 5.19, 8.9), on /api/v1/theme. The look is the brand kit: these routes pick a preset, tune its accent
 * from the logo, set the seller's own seal and ticker words, and read a look from the business's website. Only the kit changes:
 * products, pages, links and orders are never touched by a change of look (F-103).
 */

const MEDIA_PATH = /^\/media\/([0-9a-f-]{36})$/i;
const LOGO_EDGE = 512;
const STYLESHEETS_READ = 2;
const LOGOS_TRIED = 2;
const actorOf = (user) => `user:${user?.id ?? 0}`;
const shortNote = (text) => String(text).replace(/[<>\0]/g, '').slice(0, 200);

const toTheme = (kit) => ({
  preset: kit.preset,
  presetName: kit.presetName,
  colors: kit.colors,
  headingFont: kit.headingFont,
  bodyFont: kit.bodyFont,
  logoUrl: kit.logoUrl,
  slots: kit.slots,
  sealText: kit.sealText,
  tickerItems: kit.tickerItems,
  source: kit.themeSource,
  check: kit.themeCheck,
  notes: kit.themeNotes,
  accentFrom: kit.accentFrom,
  website: kit.website,
});

const toRead = (row) => ({
  id: row.id,
  website: row.website,
  status: row.status,
  colors: row.colors ?? {},
  headingFont: row.heading_font,
  bodyFont: row.body_font,
  logoUrl: row.logo_url,
  notes: row.notes ?? [],
  appliedAt: row.applied_at,
  createdAt: row.created_at,
});

/** The address to read: what the owner typed, with https:// when they left it off. Throws a 400 for anything that isn't a website. */
export function websiteAddress(input) {
  const typed = String(input ?? '').trim();
  const text = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalidField('website', 'Enter a website address, like yourshop.com');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 500 || /[\s<>"'\\]/.test(url.href)) {
    throw invalidField('website', 'Enter a website address, like yourshop.com');
  }
  return url.href;
}

const everyColourCleared = () => Object.fromEntries(COLOR_KEYS.map((key) => [key, '']));

export function themesApi(ctx) {
  const { repos, platform, ig } = ctx;

  async function imageBytes(link) {
    const own = MEDIA_PATH.exec(String(link));
    if (own) return (await repos.media.get(own[1]))?.data ?? null;
    if (/^https:\/\//i.test(String(link))) return (await platform.fetcher.image(link)).buffer;
    return null;
  }

  /** The main colour of an image, read from a small clean copy of it. Null when it has none or can't be read. */
  async function mainColour(bytes) {
    if (!bytes) return null;
    const small = await platform.images.ingest(bytes, { maxEdge: 64 });
    const { default: sharp } = await import('sharp');
    const { data, info } = await sharp(small.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return dominantColor(data, { channels: info.channels });
  }

  /** The Instagram profile photo, when the account's client gives its address. Used only when there is no logo (5.19). */
  async function profilePhoto() {
    try {
      const account = await repos.igAccounts.current();
      if (!account?.token || !ig?.getAccount) return '';
      const link = (await ig.getAccount(account))?.profile_picture_url;
      return typeof link === 'string' && /^https:\/\//i.test(link) ? link : '';
    } catch {
      return '';
    }
  }

  /** The accent for a preset, tuned from the logo, or from the profile photo when there is no logo: { colors, from, notes }. */
  async function tunedAccent(presetColors) {
    const kit = await repos.brandKit.get();
    const source = kit.logoUrl ? { from: 'logo', link: kit.logoUrl } : { from: 'profile_photo', link: await profilePhoto() };
    if (!source.link) return { colors: {}, from: '', notes: [] };
    try {
      const tuned = tuneAccent(await mainColour(await imageBytes(source.link)), presetColors);
      if (!tuned) return { colors: {}, from: '', notes: [] };
      const what = source.from === 'logo' ? 'logo' : 'profile photo';
      return {
        colors: { accent: tuned.accent, on_accent: tuned.on_accent },
        from: source.from,
        notes: tuned.changed ? [`The ${what}’s colour was adjusted so text on it is easy to read.`] : [],
      };
    } catch (err) {
      // A logo that can't be read leaves the preset's own accent: picking a look never fails for it.
      log.warn('theme.accent_failed', { code: err?.code ?? 'error' });
      return { colors: {}, from: '', notes: [] };
    }
  }

  /** Reads the website's look. Every outside call goes through safeFetch; a refusal is recorded as the read's result. */
  async function readSite(website, user) {
    const { fetcher, images } = platform;
    let page;
    try {
      page = await fetcher.page(website);
    } catch (err) {
      if (!(err instanceof SafeFetchError)) throw err;
      const why = Object.hasOwn(IMPORT_REASONS, err.code) ? IMPORT_REASONS[err.code] : 'We couldn’t read that website.';
      return repos.themeSiteReads.add({ website, status: err.code === 'blocked' ? 'blocked' : 'failed', notes: [shortNote(why)], userId: user?.id ?? null });
    }
    const host = new URL(page.url).host;
    const sameSite = (link) => {
      try {
        return new URL(link).host === host;
      } catch {
        return false;
      }
    };
    let look = extractLook({ html: page.html, pageUrl: page.url });
    const css = [];
    for (const href of look.stylesheets.filter(sameSite).slice(0, STYLESHEETS_READ)) {
      try {
        css.push((await fetcher.stylesheet(href)).css);
      } catch (err) {
        log.info('theme.stylesheet_skipped', { code: err?.code ?? 'error' });
      }
    }
    let manifest = null;
    if (look.manifestUrl && sameSite(look.manifestUrl) && (!look.found.primary || !look.logoCandidates.length)) {
      try {
        manifest = (await fetcher.json(look.manifestUrl)).data;
      } catch (err) {
        log.info('theme.manifest_skipped', { code: err?.code ?? 'error' });
      }
    }
    if (css.length || manifest) look = extractLook({ html: page.html, css, manifest: manifest && typeof manifest === 'object' ? manifest : null, pageUrl: page.url });

    let logoUrl = '';
    for (const candidate of look.logoCandidates.slice(0, LOGOS_TRIED)) {
      try {
        const clean = await images.ingest((await fetcher.image(candidate)).buffer, { maxEdge: LOGO_EDGE });
        logoUrl = `/media/${await repos.media.save(clean.buffer, clean.contentType)}`;
        break;
      } catch (err) {
        log.info('theme.logo_skipped', { code: err?.code ?? 'error' });
      }
    }

    const kit = await repos.brandKit.get();
    const { colors, notes: colourNotes } = lookColors(look.found, kit.colors);
    const notes = [...look.notes, ...colourNotes];
    if (look.scriptOnly) notes.unshift('This website is drawn by JavaScript, so its colours couldn’t be read. The look stays as it is, with the logo. Please check the theme.');
    else if (!look.anyColour) notes.push('No colours could be read from this website, so the colours stay as they are.');
    if (!logoUrl) notes.push('No logo could be read from this website.');
    return repos.themeSiteReads.add({
      website,
      status: look.scriptOnly ? 'script_only' : 'read',
      colors: look.scriptOnly ? {} : colors,
      headingFont: look.scriptOnly ? '' : look.fonts.heading ?? '',
      bodyFont: look.scriptOnly ? '' : look.fonts.body ?? '',
      logoUrl,
      notes: notes.map(shortNote).slice(0, 20),
      userId: user?.id ?? null,
    });
  }

  return {
    'themes.presets': async () => ({
      items: (await repos.brandKit.presets()).map((p) => ({ code: p.code, name: p.name, madeFor: p.made_for ?? '', colors: p.colors, headingFont: p.heading_font, bodyFont: p.body_font, slots: resolveSlots(p.slots) })),
    }),

    'themes.get': async () => toTheme(await repos.brandKit.get()),

    'themes.choose': async ({ body, user }) => {
      if (!(await repos.entitlements.can('theme_presets'))) throw new ApiError('forbidden', 'Ready-made looks aren’t part of your plan.', { reason: PLAN_REASON });
      const preset = await repos.themeSiteReads.presetOffered(body.preset);
      if (!preset) throw invalidField('preset', 'Pick a look');
      const accent = body.tuneAccent ? await tunedAccent(preset.colors) : { colors: {}, from: '', notes: [] };
      const kit = await repos.brandKit.save({
        preset: body.preset,
        colors: { ...everyColourCleared(), ...accent.colors },
        headingFont: '',
        bodyFont: '',
        themeSource: 'preset',
        themeCheck: false,
        themeNotes: accent.notes,
        accentFrom: accent.from,
      });
      await repos.themeSiteReads.audit({ actor: actorOf(user), action: 'theme.preset_chosen', target: `preset:${body.preset}`, details: { accentFrom: accent.from } });
      return toTheme(kit);
    },

    'themes.updateText': async ({ body, user }) => {
      const kit = await repos.brandKit.save({ sealText: body.sealText, tickerItems: body.tickerItems });
      await repos.themeSiteReads.audit({ actor: actorOf(user), action: 'theme.text_updated', details: { fields: Object.keys(body) } });
      return toTheme(kit);
    },

    'themes.readSite': async ({ body, user }) => toRead(await readSite(websiteAddress(body.website), user)),

    'themes.siteReads': async ({ query }) => {
      const before = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const page = pageOfFetched(await repos.themeSiteReads.list({ beforeId: before, limit: query.limit }), query.limit, (row) => [row.id]);
      return { items: page.items.map(toRead), nextCursor: page.nextCursor };
    },

    'themes.applySiteRead': async ({ params, user }) => {
      const read = await repos.themeSiteReads.get(params.id);
      if (!read) return null;
      if (read.status === 'failed' || read.status === 'blocked') throw new ApiError('conflict', 'That read didn’t find a look to use. Read the website again.');
      const colors = Object.fromEntries(Object.entries(read.colors ?? {}).filter(([key, value]) => COLOR_KEYS.includes(key) && isHexColor(value)));
      const hasLook = read.status === 'read' && (Object.keys(colors).length > 0 || read.heading_font || read.body_font);
      const change = {
        themeNotes: (read.notes ?? []).map(shortNote),
        website: read.website,
        ...(read.logo_url ? { logoUrl: read.logo_url } : {}),
      };
      if (hasLook) {
        Object.assign(change, {
          colors: { ...everyColourCleared(), ...colors },
          ...(read.heading_font ? { headingFont: read.heading_font } : {}),
          ...(read.body_font ? { bodyFont: read.body_font } : {}),
          themeSource: 'website',
          // Our team looks again when anything was changed on the way in: a swapped font or a colour moved for contrast.
          themeCheck: change.themeNotes.length > 0,
          accentFrom: 'website',
        });
      } else {
        // A site with nothing to read keeps the preset, with its logo, flagged for a check (8.9).
        Object.assign(change, { themeSource: 'preset', themeCheck: true });
      }
      const kit = await repos.brandKit.save(change);
      await repos.themeSiteReads.markApplied(read.id);
      await repos.themeSiteReads.audit({ actor: actorOf(user), action: 'theme.site_applied', target: `site_read:${read.id}`, details: { status: read.status } });
      return toTheme(kit);
    },
  };
}
