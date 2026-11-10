import { z } from 'zod';
import { PresetSlots, ThemeTextUpdate } from '../themes.js';
import { MANAGERS } from './access.js';
import { Id, IdParams, ListQuery, Timestamp, page, text } from './common.js';

/**
 * A business's look on buyer pages (PRD 5.3, 5.19, 8.9), answered by src/modules/themes. It is the brand kit: a preset's
 * colours, fonts and slots, the seller's own changes, and where the look came from. Presets are rows, so a new one appears
 * for every seller with no code change (F-107). Switching presets changes the look only: products, pages, links and orders
 * are untouched (F-103). The screens that edit it are Bhava-branded; only buyer pages wear it.
 */
const Colors = z.record(z.string(), z.string());

export const ThemePresetCard = z.object({
  code: z.string(),
  name: z.string(),
  madeFor: z.string(),
  colors: Colors,
  headingFont: z.string(),
  bodyFont: z.string(),
  slots: PresetSlots,
});

export const BuyerTheme = z.object({
  preset: z.string(),
  presetName: z.string(),
  colors: Colors,
  headingFont: z.string(),
  bodyFont: z.string(),
  logoUrl: z.string(),
  slots: PresetSlots,
  /** The seller's own seal text and ticker; empty means the preset's (F-106). */
  sealText: z.string(),
  tickerItems: z.array(z.string()),
  source: z.enum(['preset', 'website']),
  /** Our team should look: the website was all JavaScript, or the read changed colours to pass contrast. */
  check: z.boolean(),
  notes: z.array(z.string()),
  accentFrom: z.enum(['', 'logo', 'profile_photo', 'website']),
  website: z.string(),
});

/** Picking a look (F-102). The accent is tuned from the logo, or the Instagram photo when there is none, then darkened until it passes 4.5:1 (F-104). */
export const ThemeChoose = z.object({ preset: z.string().trim().regex(/^[a-z0-9-]{1,40}$/, 'Pick a look'), tuneAccent: z.boolean().default(true) });
export const ThemeText = ThemeTextUpdate;

export const SiteReadCreate = z.object({ website: text(500).min(4, 'Enter the website') });
/** One read of a website's look (8.9). Unknown fonts are mapped to the nearest supported family; failing pairs moved to black or white, with a note. */
export const SiteRead = z.object({
  id: Id,
  website: z.string(),
  status: z.enum(['read', 'script_only', 'failed', 'blocked']),
  colors: Colors,
  headingFont: z.string(),
  bodyFont: z.string(),
  logoUrl: z.string(),
  notes: z.array(z.string()),
  appliedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});

export const themeRoutes = {
  'themes.presets': { method: 'GET', path: '/theme/presets', access: MANAGERS, response: z.object({ items: z.array(ThemePresetCard) }) },
  'themes.get': { method: 'GET', path: '/theme', access: MANAGERS, response: BuyerTheme },
  'themes.choose': { method: 'PUT', path: '/theme', access: MANAGERS, body: ThemeChoose, response: BuyerTheme },
  'themes.updateText': { method: 'PATCH', path: '/theme', access: MANAGERS, body: ThemeText, response: BuyerTheme },
  'themes.readSite': { method: 'POST', path: '/theme/site-reads', access: MANAGERS, body: SiteReadCreate, status: 201, response: SiteRead },
  'themes.siteReads': { method: 'GET', path: '/theme/site-reads', access: MANAGERS, query: ListQuery, response: page(SiteRead) },
  /** Saves a read to the brand kit (5.3); our team reviews it first in onboarding. */
  'themes.applySiteRead': { method: 'POST', path: '/theme/site-reads/:id/apply', access: MANAGERS, params: IdParams, response: BuyerTheme },
};
