import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { COLOR_KEYS, FONTS, contrastRatio, isHexColor } from './theme.js';

export const DEFAULT_PRESET = 'utsav';
const MIN_CONTRAST = 4.5;

const LINK_FIELDS = { logoUrl: 'logo_url', logoDarkUrl: 'logo_dark_url', faviconUrl: 'favicon_url' };
const FONT_FIELDS = { headingFont: 'heading_font', bodyFont: 'body_font' };

function cleanLink(value, label) {
  const link = String(value ?? '').trim();
  if (link && !(/^https?:\/\/\S+$/i.test(link) || /^\/media\/[\w-]+$/.test(link))) {
    throw new ValidationError(`${label} must be a web link starting with http:// or https://`);
  }
  if (link.length > 1000) throw new ValidationError(`${label} is too long`);
  return link;
}

function cleanColors(colors) {
  const out = {};
  for (const [key, value] of Object.entries(colors ?? {})) {
    if (!COLOR_KEYS.includes(key)) throw new ValidationError(`Unknown colour “${key}”`);
    if (value !== '' && !isHexColor(value)) throw new ValidationError(`${key} must be a colour like #234D33`);
    out[key] = value === '' ? '' : String(value).toUpperCase();
  }
  return out;
}

function toKit(row) {
  return {
    preset: row.preset,
    presetName: row.preset_name,
    logoUrl: row.logo_url || '',
    logoDarkUrl: row.logo_dark_url || '',
    faviconUrl: row.favicon_url || '',
    colors: { ...row.preset_colors, ...row.colors },
    headingFont: row.heading_font || row.preset_heading_font,
    bodyFont: row.body_font || row.preset_body_font,
  };
}

/** Each business's brand kit: a preset plus its own changes. Buyer surfaces only; seller surfaces stay Bhava-branded. */
export function brandKitRepo(db) {
  return {
    /** The kit to use right now. A business that never saved one gets the default preset. */
    async get() {
      const [row] = await db.query(
        `SELECT p.code AS preset, p.name AS preset_name, p.colors AS preset_colors, p.heading_font AS preset_heading_font,
                p.body_font AS preset_body_font, k.logo_url, k.logo_dark_url, k.favicon_url, COALESCE(k.colors, '{}') AS colors,
                k.heading_font, k.body_font
         FROM theme_presets p LEFT JOIN brand_kits k ON k.tenant_id = $1 AND k.preset = p.code
         WHERE p.code = COALESCE((SELECT preset FROM brand_kits WHERE tenant_id = $1), $2)`,
        [tenantId(), DEFAULT_PRESET],
      );
      return toKit(row);
    },

    /** Every preset a seller can pick, for "Pick a look". */
    async presets() {
      return db.query('SELECT code, name, colors, heading_font, body_font FROM theme_presets ORDER BY position, code');
    },

    /**
     * Saves part of the kit; fields left out stay as they are. Fields: preset, logoUrl, logoDarkUrl, faviconUrl,
     * colors (a partial map, '' clears one), headingFont, bodyFont. Switching preset starts from the new
     * preset's colours and fonts unless this same call sets others.
     */
    async save(input = {}) {
      const tenant = tenantId();
      const [current] = await db.query('SELECT * FROM brand_kits WHERE tenant_id = $1', [tenant]);
      const code = String(input.preset ?? current?.preset ?? DEFAULT_PRESET);
      const [preset] = await db.query('SELECT colors FROM theme_presets WHERE code = $1', [code]);
      if (!preset) throw new ValidationError(`There is no theme called “${code}”`);
      const samePreset = current?.preset === code;

      const overrides = { ...(samePreset ? current.colors : {}), ...cleanColors(input.colors) };
      for (const key of Object.keys(overrides)) if (overrides[key] === '') delete overrides[key];
      const colors = { ...preset.colors, ...overrides };
      const ratio = contrastRatio(colors.primary, colors.on_primary);
      if (ratio < MIN_CONTRAST) {
        throw new ValidationError(`primary and on_primary need a contrast of at least ${MIN_CONTRAST}:1, and this pair is ${ratio.toFixed(1)}:1`);
      }

      const next = { logo_url: '', logo_dark_url: '', favicon_url: '', heading_font: '', body_font: '', ...current };
      for (const [field, column] of Object.entries(LINK_FIELDS)) {
        if (input[field] !== undefined) next[column] = cleanLink(input[field], field);
      }
      if (!samePreset) Object.assign(next, { heading_font: '', body_font: '' });
      for (const [field, column] of Object.entries(FONT_FIELDS)) {
        if (input[field] === undefined) continue;
        const font = String(input[field]);
        if (font && !Object.hasOwn(FONTS, font)) throw new ValidationError(`The font “${font}” isn’t available`);
        next[column] = font;
      }

      await db.query(
        `INSERT INTO brand_kits (tenant_id, preset, logo_url, logo_dark_url, favicon_url, colors, heading_font, body_font)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id) DO UPDATE SET preset = EXCLUDED.preset, logo_url = EXCLUDED.logo_url,
           logo_dark_url = EXCLUDED.logo_dark_url, favicon_url = EXCLUDED.favicon_url, colors = EXCLUDED.colors,
           heading_font = EXCLUDED.heading_font, body_font = EXCLUDED.body_font, updated_at = now()`,
        [tenant, code, next.logo_url, next.logo_dark_url, next.favicon_url, JSON.stringify(overrides), next.heading_font, next.body_font],
      );
      return this.get();
    },
  };
}
