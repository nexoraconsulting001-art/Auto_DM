import { z } from 'zod';
import { MANAGERS } from './access.js';
import { ListQuery, MediaLinkOrEmpty, page, text } from './common.js';

const Colors = z.record(z.string(), z.string());
const HexOrEmpty = z.string().regex(/^(#[0-9a-fA-F]{6})?$/, 'Use a colour like #234D33');

export const BrandKit = z.object({
  preset: z.string(),
  presetName: z.string(),
  logoUrl: z.string(),
  logoDarkUrl: z.string(),
  faviconUrl: z.string(),
  colors: Colors,
  headingFont: z.string(),
  bodyFont: z.string(),
  publicReplyVariants: z.array(z.string()).default([]),
});

/** Fields left out stay as they are. In `colors`, an empty value returns that slot to the preset's colour. */
export const BrandKitUpdate = z.object({
  preset: text(40),
  logoUrl: MediaLinkOrEmpty,
  logoDarkUrl: MediaLinkOrEmpty,
  faviconUrl: MediaLinkOrEmpty,
  colors: z.record(text(40), HexOrEmpty),
  headingFont: text(80),
  bodyFont: text(80),
  publicReplyVariants: z.array(text(150)).max(10, 'Use at most 10 replies'),
}).partial();

export const ThemePreset = z.object({ code: z.string(), name: z.string(), colors: Colors, headingFont: z.string(), bodyFont: z.string() });

export const brandKitRoutes = {
  'brandKit.get': { method: 'GET', path: '/brand-kit', access: MANAGERS, response: BrandKit },
  'brandKit.update': { method: 'PATCH', path: '/brand-kit', access: MANAGERS, body: BrandKitUpdate, response: BrandKit },
  'brandKit.presets': { method: 'GET', path: '/brand-kit/presets', access: MANAGERS, query: ListQuery, response: page(ThemePreset) },
};
