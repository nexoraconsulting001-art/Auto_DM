/**
 * Turns a brand kit into what a buyer page needs. No database and no request here, so a view can call
 * these directly. The colour keys are the slots every theme fills (see the theme_presets table).
 */
export const COLOR_KEYS = ['ground', 'card', 'ink', 'muted', 'line', 'primary', 'on_primary', 'accent', 'on_accent', 'eyebrow'];

// The allow-list (PRD 5.3): family -> the weights Google Fonts serves for it, and what to fall back on.
const SANS = 'system-ui, sans-serif';
const SERIF = 'Georgia, serif';
export const FONTS = {
  'Bricolage Grotesque': { weights: '400;500;600;700;800', fallback: SANS },
  'Cormorant Garamond': { weights: '400;500;600;700', fallback: SERIF },
  'DM Sans': { weights: '400;500;600;700', fallback: SANS },
  'DM Serif Display': { weights: '400', fallback: SERIF },
  Figtree: { weights: '400;500;600;700;800', fallback: SANS },
  Hind: { weights: '400;500;600;700', fallback: SANS },
  Inter: { weights: '400;500;600;700;800', fallback: SANS },
  Jost: { weights: '400;500;600;700', fallback: SANS },
  Lato: { weights: '400;700', fallback: SANS },
  Lora: { weights: '400;500;600;700', fallback: SERIF },
  Manrope: { weights: '400;500;600;700;800', fallback: SANS },
  Merriweather: { weights: '400;700', fallback: SERIF },
  Montserrat: { weights: '400;500;600;700;800', fallback: SANS },
  Mukta: { weights: '400;500;600;700', fallback: SANS },
  'Noto Sans': { weights: '400;500;600;700', fallback: SANS },
  'Noto Serif': { weights: '400;500;600;700', fallback: SERIF },
  Nunito: { weights: '400;600;700;800', fallback: SANS },
  'Open Sans': { weights: '400;600;700', fallback: SANS },
  'Playfair Display': { weights: '400;500;600;700;800', fallback: SERIF },
  Poppins: { weights: '400;500;600;700', fallback: SANS },
  Roboto: { weights: '400;500;700', fallback: SANS },
  'Space Grotesk': { weights: '400;500;600;700', fallback: SANS },
  'Work Sans': { weights: '400;500;600;700', fallback: SANS },
};

export const isHexColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value));

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance(hex) {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast between two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a, b, amountOfA) {
  const [ca, cb] = [channels(a), channels(b)];
  const hex = ca.map((c, i) => Math.round(c * amountOfA + cb[i] * (1 - amountOfA)).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

const family = (name) => {
  const font = Object.hasOwn(FONTS, name) ? FONTS[name] : null;
  return font ? `'${name}', ${font.fallback}` : SANS;
};

/**
 * CSS custom properties for a kit. It goes inside a <style> tag, where HTML escaping does nothing, so every
 * value is checked again here even though the repo validated it when saving.
 */
export function brandCss(kit) {
  const c = kit.colors;
  const vars = {
    '--ink': c.ink,
    '--on-ink': c.ground,
    '--ink-2': c.muted,
    '--paper': c.ground,
    '--mist': c.card,
    '--line': c.line,
    '--gold': c.primary,
    '--on-gold': c.on_primary,
    '--gold-deep': c.eyebrow,
    '--gold-soft': isHexColor(c.primary) && isHexColor(c.ground) ? mix(c.primary, c.ground, 0.1) : '',
    '--accent': c.accent,
    '--on-accent': c.on_accent,
  };
  const colors = Object.entries(vars).filter(([, v]) => isHexColor(v)).map(([k, v]) => `${k}:${v}`);
  const scheme = isHexColor(c.ground) && luminance(c.ground) < 0.2 ? 'dark' : 'light';
  return `:root{${[...colors, `--display:${family(kit.headingFont)}`, `--body:${family(kit.bodyFont)}`, `color-scheme:${scheme}`].join(';')}}`;
}

/** The stylesheet link for a kit's two fonts. */
export function brandFontsHref(kit) {
  const families = [...new Set([kit.headingFont, kit.bodyFont])]
    .filter((name) => Object.hasOwn(FONTS, name))
    .map((name) => `family=${name.replace(/ /g, '+')}:wght@${FONTS[name].weights}`);
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}
