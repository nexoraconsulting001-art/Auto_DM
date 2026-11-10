import { z } from 'zod';

/**
 * The template slots every theme preset fills (PRD 5.19), as names the one buyer layout (src/views/buyer) knows how to draw.
 * A preset is a row of theme_presets with colours, two fonts and these slots; no slot holds CSS, so a sixth preset is data
 * (F-107) and can't put markup or script on a buyer page. Sections and their order never come from a preset (F-105).
 */
export const PRESET_SLOTS = Object.freeze({
  reelFrame: Object.freeze(['arch', 'dewdrop', 'tilted', 'screen', 'pebble', 'plain']),
  photoShape: Object.freeze(['arch', 'circle', 'outlined', 'rounded', 'leaf', 'square']),
  cardStyle: Object.freeze(['framed', 'floating', 'brutalist', 'panel', 'stitched', 'plain']),
  buttonStyle: Object.freeze(['solid', 'pill', 'hard_shadow', 'outline']),
  buttonCase: Object.freeze(['upper', 'none']),
  pattern: Object.freeze(['none', 'blush', 'dots', 'grid', 'linen']),
  highlight: Object.freeze(['underline', 'italic', 'marker', 'color']),
  flourish: Object.freeze(['diamond', 'wave', 'squiggle', 'arrow', 'vine', 'line']),
  sealIcon: Object.freeze(['diamond', 'drop', 'pot', 'bolt', 'leaf', 'star']),
  ticker: Object.freeze(['rule', 'pill', 'tilted', 'band', 'stitched']),
  priceStyle: Object.freeze(['display', 'body', 'neon']),
  labelStyle: Object.freeze(['plain', 'code']),
  logoShape: Object.freeze(['arch', 'circle', 'brutal', 'square', 'leaf']),
  offTag: Object.freeze(['flat', 'pill', 'tilted', 'code']),
});

export const SEAL_TEXT_MAX = 60;
export const TICKER_ITEMS_MAX = 8;
export const TICKER_ITEM_LENGTH = 40;

const slot = (name) => z.enum(PRESET_SLOTS[name]);
const noMarkup = (max) => z.string().trim().min(1).max(max).regex(/^[^<>{}\0]*$/, 'Use plain words only');

/** A preset's slots as stored in theme_presets.slots. Anything else in the row is refused. */
export const PresetSlots = z.object({
  reelFrame: slot('reelFrame'),
  photoShape: slot('photoShape'),
  cardStyle: slot('cardStyle'),
  buttonStyle: slot('buttonStyle'),
  buttonCase: slot('buttonCase'),
  radius: z.number().int().min(0).max(999),
  pattern: slot('pattern'),
  highlight: slot('highlight'),
  flourish: slot('flourish'),
  sealIcon: slot('sealIcon'),
  ticker: slot('ticker'),
  priceStyle: slot('priceStyle'),
  labelStyle: slot('labelStyle'),
  logoShape: slot('logoShape'),
  offTag: slot('offTag'),
  displayWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(800)]),
  sealText: noMarkup(SEAL_TEXT_MAX),
  tickerItems: z.array(noMarkup(TICKER_ITEM_LENGTH)).min(1).max(TICKER_ITEMS_MAX),
}).strict();

/** What the default preset looks like if a row's slots are missing or broken: the layout never fails for want of a slot. */
export const FALLBACK_SLOTS = Object.freeze({
  reelFrame: 'plain', photoShape: 'rounded', cardStyle: 'plain', buttonStyle: 'solid', buttonCase: 'none', radius: 8, pattern: 'none',
  highlight: 'color', flourish: 'line', sealIcon: 'star', ticker: 'rule', priceStyle: 'body', labelStyle: 'plain', logoShape: 'circle',
  offTag: 'pill', displayWeight: 700, sealText: 'Shop the reel', tickerItems: Object.freeze(['Shop the reel']),
});

/** A seller's own seal text and ticker items (F-106). Empty seal text or an empty list keeps the preset's. */
export const ThemeTextUpdate = z.object({
  sealText: z.union([z.literal(''), noMarkup(SEAL_TEXT_MAX)]),
  tickerItems: z.array(noMarkup(TICKER_ITEM_LENGTH)).max(TICKER_ITEMS_MAX),
}).partial();

/**
 * The slots a buyer page uses: the preset's, with the seller's seal text and ticker over them. Unknown or broken preset slots
 * fall back one by one, so a bad row can't break a page.
 */
export function resolveSlots(presetSlots, { sealText = '', tickerItems = [] } = {}) {
  const out = { ...FALLBACK_SLOTS };
  const shape = PresetSlots.shape;
  for (const [key, schema] of Object.entries(shape)) {
    const value = presetSlots?.[key];
    if (value !== undefined && schema.safeParse(value).success) out[key] = value;
  }
  if (sealText && ThemeTextUpdate.shape.sealText.safeParse(sealText).success) out.sealText = sealText;
  if (Array.isArray(tickerItems) && tickerItems.length && ThemeTextUpdate.shape.tickerItems.safeParse(tickerItems).success) out.tickerItems = [...tickerItems];
  return out;
}
