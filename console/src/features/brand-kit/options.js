/**
 * What a brand kit can hold. The server's copy is in src/modules/brand/theme.js, which the console can't import
 * (only src/contracts is available to the console build); a test keeps the two in step.
 */
export const COLOR_SLOTS = Object.freeze([
  ['primary', 'Buttons'],
  ['on_primary', 'Text on buttons'],
  ['accent', 'Accent'],
  ['on_accent', 'Text on accent'],
  ['ground', 'Page background'],
  ['card', 'Card background'],
  ['ink', 'Main text'],
  ['muted', 'Soft text'],
  ['line', 'Lines'],
  ['eyebrow', 'Small headings'],
]);

export const FONT_CHOICES = Object.freeze([
  'Bricolage Grotesque', 'Cormorant Garamond', 'DM Sans', 'DM Serif Display', 'Figtree', 'Hind', 'Inter', 'Jost', 'Lato', 'Lora', 'Manrope',
  'Merriweather', 'Montserrat', 'Mukta', 'Noto Sans', 'Noto Serif', 'Nunito', 'Open Sans', 'Playfair Display', 'Poppins', 'Roboto', 'Space Grotesk', 'Work Sans',
]);

export const MIN_CONTRAST = 4.5;

export const isHex = (value) => /^#[0-9a-f]{6}$/i.test(String(value));

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast between two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export function kitToForm(kit) {
  return {
    preset: kit.preset,
    logoUrl: kit.logoUrl,
    logoDarkUrl: kit.logoDarkUrl,
    faviconUrl: kit.faviconUrl,
    colors: Object.fromEntries(COLOR_SLOTS.map(([key]) => [key, kit.colors[key] ?? ''])),
    headingFont: kit.headingFont,
    bodyFont: kit.bodyFont,
  };
}

/** Picking a look starts from that look's colours and fonts. Logos stay. */
export function applyPreset(form, preset) {
  return {
    ...form,
    preset: preset.code,
    colors: Object.fromEntries(COLOR_SLOTS.map(([key]) => [key, preset.colors[key] ?? ''])),
    headingFont: preset.headingFont,
    bodyFont: preset.bodyFont,
  };
}

/** The form as the API wants it, or `errors` by field. A value equal to the preset's is sent empty, so it follows the preset. */
export function formToKit(form, preset) {
  const errors = {};
  for (const [key] of COLOR_SLOTS) {
    if (!isHex(form.colors[key])) errors[`color_${key}`] = 'Use a colour like #234D33';
  }
  if (!errors.color_primary && !errors.color_on_primary) {
    const ratio = contrastRatio(form.colors.primary, form.colors.on_primary);
    if (ratio < MIN_CONTRAST) errors.color_on_primary = `Buttons and their text need a contrast of at least ${MIN_CONTRAST}:1. This pair is ${ratio.toFixed(1)}:1.`;
  }
  if (Object.keys(errors).length) return { errors };
  const colors = {};
  for (const [key] of COLOR_SLOTS) colors[key] = preset && same(form.colors[key], preset.colors[key]) ? '' : form.colors[key];
  return {
    body: {
      preset: form.preset,
      logoUrl: form.logoUrl,
      logoDarkUrl: form.logoDarkUrl,
      faviconUrl: form.faviconUrl,
      colors,
      headingFont: preset && form.headingFont === preset.headingFont ? '' : form.headingFont,
      bodyFont: preset && form.bodyFont === preset.bodyFont ? '' : form.bodyFont,
    },
  };
}
