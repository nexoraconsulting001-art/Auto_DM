/**
 * Design tokens for the apps. Screens use these names, never raw values.
 *
 *   sellerTheme          Neel and Haldi: everything a seller uses (the owner app). The same values as
 *                        console/src/design/tokens.css; a test keeps the two in step.
 *   fromBrandKit(kit)    a theme made from one business's brand kit, for what its buyers see (the shopper app,
 *                        Phase 6). `kit` is what repos.brandKit.get() answers: { colors, headingFont, bodyFont },
 *                        with the colour keys ground, card, ink, muted, line, primary, on_primary and accent.
 *
 * A theme is plain data: { name, color, font, text, space, radius, tap }. Components in @bhava/ui read it from
 * the ThemeProvider and never import a colour themselves, so one component serves both apps.
 */
export const color = Object.freeze({
  ground: '#f6f5f1',
  surface: '#ffffff',
  surfaceSunken: '#f3f2f7',
  ink: '#16152b',
  ink2: '#4b4a63',
  ink3: '#6a6985',
  line: '#e7e5ee',
  lineSoft: '#f0eff4',
  dots: '#d8d5e6',

  primary: '#3b2fc9', // neel
  primaryDeep: '#2c2399',
  primaryTint: '#eceafd',
  primaryLine: '#d3cef8',
  primaryOnInk: '#8c83f0',
  onPrimary: '#ffffff',

  accent: '#f5b83d', // haldi
  accentTint: '#fff3d6',
  accentText: '#7a5200',

  goodText: '#17694a',
  goodTint: '#e3f5ec',
  badText: '#b4432c',
  badTint: '#fde8e6',

  inkRaised: '#22213b',
  inkLine: '#34335a',
  onInk: '#ffffff',
  onInk2: '#c9c7dd',
  onInkIcon: '#e4e2f2',
});

/** The token names in console/src/design/tokens.css that each colour here mirrors. */
export const CSS_NAMES = Object.freeze({
  ground: '--ground', surface: '--surface', surfaceSunken: '--surface-sunken', ink: '--ink', ink2: '--ink-2', ink3: '--ink-3',
  line: '--line', lineSoft: '--line-soft', dots: '--dots',
  primary: '--neel', primaryDeep: '--neel-deep', primaryTint: '--neel-tint', primaryLine: '--neel-line', primaryOnInk: '--neel-on-ink',
  accent: '--haldi', accentTint: '--haldi-tint', accentText: '--haldi-text',
  goodText: '--good-text', goodTint: '--good-tint', badText: '--bad-text', badTint: '--bad-tint',
  inkRaised: '--ink-raised', inkLine: '--ink-line', onInk: '--on-ink', onInk2: '--on-ink-2', onInkIcon: '--on-ink-icon',
});

/** Font family names as the app registers them (apps/owner/app.config.js embeds the files under these names). */
export const font = Object.freeze({
  display: 'Unbounded_600SemiBold',
  displayBold: 'Unbounded_700Bold',
  body: 'Figtree_400Regular',
  bodyMedium: 'Figtree_500Medium',
  bodySemiBold: 'Figtree_600SemiBold',
  bodyBold: 'Figtree_700Bold',
});

export const text = Object.freeze({ caption: 12, meta: 13, small: 14, body: 15, title: 17, page: 26 });
export const space = Object.freeze({ 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, gutter: 20 });
export const radius = Object.freeze({ small: 10, tile: 14, field: 16, card: 24, pill: 999 });
/** The smallest thing a finger is asked to hit, on both platforms. */
export const tap = Object.freeze({ min: 44, large: 52 });

export const sellerTheme = Object.freeze({ name: 'neel-haldi', color, font, text, space, radius, tap });

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const full = (hex) => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex).toLowerCase();
const channels = (hex) => [1, 3, 5].map((i) => parseInt(full(hex).slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')).join('')}`;

/** `amount` from 0 (the colour) to 1 (the other colour). */
export function mix(hex, other, amount) {
  const [a, b] = [channels(hex), channels(other)];
  return toHex(a.map((n, i) => n + (b[i] - n) * amount));
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast between two colours, from 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const pick = (value, fallback) => (typeof value === 'string' && HEX.test(value.trim()) ? full(value.trim()) : fallback);
const readable = (onColor) => (contrast('#ffffff', onColor) >= contrast('#000000', onColor) ? '#ffffff' : '#000000');

/**
 * A theme for one business, from its brand kit. Anything the kit leaves out, or that is not a hex colour, falls back
 * to a neutral value. Text on the primary colour is the kit's own on_primary when that reaches 4.5:1, and otherwise
 * black or white, whichever reads better; body text that is too faint on the kit's background is replaced the same
 * way. Fonts the app has not embedded fall back to the system font (`fonts` maps a kit font name to a family).
 */
export function fromBrandKit(kit = {}, { fonts = {} } = {}) {
  const c = kit?.colors ?? {};
  const primary = pick(c.primary, '#1f1f1f');
  const ground = pick(c.ground ?? c.background, '#ffffff');
  const kitInk = pick(c.ink ?? c.text, '#161616');
  const ink = contrast(kitInk, ground) >= 4.5 ? kitInk : readable(ground);
  const accent = pick(c.accent, primary);
  const kitOnPrimary = pick(c.on_primary ?? c.onPrimary, null);
  const onPrimary = kitOnPrimary && contrast(kitOnPrimary, primary) >= 4.5 ? kitOnPrimary : readable(primary);
  const heading = fonts[kit?.headingFont];
  const body = fonts[kit?.bodyFont];
  return Object.freeze({
    name: 'brand',
    color: Object.freeze({
      ...color,
      ground,
      surface: pick(c.card ?? c.surface, mix(ground, '#ffffff', 0.6)),
      surfaceSunken: mix(ground, ink, 0.05),
      ink,
      ink2: mix(ink, ground, 0.25),
      ink3: contrast(pick(c.muted, ground), ground) >= 4.5 ? pick(c.muted, ground) : mix(ink, ground, 0.35),
      line: pick(c.line, mix(ground, ink, 0.12)),
      lineSoft: mix(ground, ink, 0.07),
      dots: mix(ground, ink, 0.18),
      primary,
      primaryDeep: mix(primary, '#000000', 0.2),
      primaryTint: mix(primary, ground, 0.88),
      primaryLine: mix(primary, ground, 0.7),
      primaryOnInk: mix(primary, '#ffffff', 0.4),
      onPrimary,
      accent,
      accentTint: mix(accent, ground, 0.85),
      accentText: contrast(accent, ground) >= 4.5 ? accent : mix(accent, readable(ground), 0.6),
    }),
    font: Object.freeze({ display: heading, displayBold: heading, body, bodyMedium: body, bodySemiBold: body, bodyBold: body }),
    text,
    space,
    radius,
    tap,
  });
}
