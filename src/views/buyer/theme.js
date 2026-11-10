import { FONTS, brandFontsHref, contrastRatio, isHexColor } from '../../modules/brand/theme.js';
import { FALLBACK_SLOTS, resolveSlots } from '../../contracts/themes.js';

/**
 * A brand kit as the one buyer layout draws it (PRD 5.3, 5.18, 5.19): validated colours, two allowed fonts and the preset's
 * slots, turned into one small inline stylesheet. Every value written into CSS is re-checked here (a hex colour, a font from the
 * allow-list, a whole number, or a slot name looked up in the tables below), so nothing a seller or a website typed can close the
 * <style> tag (K-29). Slot names map to fixed CSS in this file: a preset is data, never CSS.
 */

/** The default preset's colours (Utsav), used for any slot a kit lacks or has broken. */
export const FALLBACK_COLORS = Object.freeze({
  ground: '#FBF6EE', card: '#FFFFFF', ink: '#2A0F18', muted: '#6E4F58', line: '#EADBCB',
  primary: '#7A1F3D', on_primary: '#FFFFFF', accent: '#D4AF37', on_accent: '#2A0F18', eyebrow: '#7A1F3D',
});
const FALLBACK_FONTS = Object.freeze({ heading: 'Cormorant Garamond', body: 'Jost' });

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgba = (hex, alpha) => `rgba(${channels(hex).join(',')},${alpha})`;
function mix(a, b, amountOfA) {
  const [ca, cb] = [channels(a), channels(b)];
  return `#${ca.map((c, i) => Math.round(c * amountOfA + cb[i] * (1 - amountOfA)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
const luminance = (hex) => contrastRatio(hex, '#000000'); // 1 for black up to 21 for white

const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const fontStack = (name, fallback) => (Object.hasOwn(FONTS, name) ? `'${name}', ${FONTS[name].fallback}` : fallback);

/**
 * The theme a page renders with: { colors, headingFont, bodyFont, slots, logoUrl, faviconUrl, scheme }. Takes repos.brandKit.get()'s
 * result. Anything missing or invalid falls back to the default preset, so a page always renders.
 */
export function buyerTheme(kit = {}) {
  const colors = {};
  for (const [key, fallback] of Object.entries(FALLBACK_COLORS)) colors[key] = isHexColor(kit.colors?.[key]) ? kit.colors[key].toUpperCase() : fallback;
  const slots = kit.slots ? resolveSlots(kit.slots, { sealText: kit.sealText, tickerItems: kit.tickerItems }) : { ...FALLBACK_SLOTS };
  const headingFont = Object.hasOwn(FONTS, kit.headingFont) ? kit.headingFont : FALLBACK_FONTS.heading;
  const bodyFont = Object.hasOwn(FONTS, kit.bodyFont) ? kit.bodyFont : FALLBACK_FONTS.body;
  const link = (value) => (/^(https:\/\/[^\s"'<>\\]+|\/media\/[\w-]+)$/i.test(String(value ?? '')) ? String(value) : '');
  return {
    preset: typeof kit.preset === 'string' ? kit.preset : 'utsav',
    colors,
    headingFont,
    bodyFont,
    slots,
    logoUrl: link(kit.logoUrl),
    faviconUrl: link(kit.faviconUrl),
    scheme: luminance(colors.ground) < 4 ? 'dark' : 'light',
  };
}

// ---- slot tables: name -> fixed CSS using the theme's custom properties ----

const FRAME = {
  arch: 'border-radius:145px 145px 10px 10px;border:2px solid var(--accent);box-shadow:0 0 0 6px var(--ground),0 0 0 7px var(--accent)',
  dewdrop: 'border-radius:58% 42% 52% 48%/44% 56% 44% 56%',
  tilted: 'border-radius:28px;border:3px solid var(--ink);box-shadow:10px 10px 0 var(--primary);transform:rotate(-2.5deg)',
  screen: 'border-radius:34px;border:8px solid var(--card);box-shadow:0 0 0 1px var(--line),0 0 60px -6px var(--glow)',
  pebble: 'border-radius:150px 30px 150px 30px',
  plain: 'border-radius:20px',
};
const PHOTO = {
  arch: ['48px 48px 6px 6px', '40px 40px 6px 6px', ''],
  circle: ['999px', '999px', ''],
  outlined: ['22px', '20px', 'border:2px solid var(--ink);'],
  rounded: ['12px', '16px', ''],
  leaf: ['44px 8px 44px 8px', '36px 6px 36px 6px', ''],
  square: ['4px', '4px', ''],
};
const CARD = {
  framed: 'border:1px solid var(--line);border-radius:8px;outline:1px solid var(--accent);outline-offset:-6px',
  floating: 'border-radius:28px;box-shadow:0 14px 30px -22px var(--shadow)',
  brutalist: 'border:2px solid var(--ink);border-radius:22px;box-shadow:5px 5px 0 var(--ink)',
  panel: 'border:1px solid var(--line);border-radius:16px',
  stitched: 'border:1.5px dashed var(--line-strong);border-radius:18px',
  plain: 'border:1px solid var(--line);border-radius:12px',
};
const BUTTON = {
  solid: 'background:var(--primary);color:var(--on-primary);border:1.5px solid var(--primary)',
  pill: 'background:var(--primary);color:var(--on-primary);border:1.5px solid var(--primary)',
  hard_shadow: 'background:var(--primary);color:var(--on-primary);border:2px solid var(--ink);box-shadow:3px 3px 0 var(--ink)',
  outline: 'background:transparent;color:var(--primary);border:1.5px solid var(--primary)',
};
const HIGHLIGHT = {
  underline: 'font-style:italic;color:var(--primary);border-bottom:2px solid var(--accent)',
  italic: 'font-style:italic;color:var(--eyebrow)',
  marker: 'background:var(--accent);color:var(--on-accent);padding:0 6px;border-radius:6px;display:inline-block;transform:rotate(-2deg)',
  color: 'color:var(--accent)',
};
const TICKER = {
  rule: ['border-top:1px solid var(--accent);border-bottom:1px solid var(--accent)', 'text-transform:uppercase;letter-spacing:.12em;color:var(--primary)', 'transform:rotate(45deg);background:var(--accent)'],
  pill: ['margin-left:20px;margin-right:20px;border-radius:999px;background:var(--card);border:1px solid var(--line)', 'color:var(--primary)', 'border-radius:999px;background:var(--accent)'],
  tilted: ['background:var(--ink);transform:rotate(-2deg);margin-left:-10px;margin-right:-10px', 'text-transform:uppercase;font-family:var(--display);font-weight:800;color:var(--accent)', 'border-radius:999px;background:var(--primary)'],
  band: ['background:var(--accent)', 'text-transform:uppercase;font-family:var(--mono);font-weight:700;color:var(--on-accent)', 'background:var(--on-accent)'],
  stitched: ['border-top:1.5px dashed var(--line-strong);border-bottom:1.5px dashed var(--line-strong)', 'font-family:var(--display);font-style:italic;color:var(--primary)', 'border-radius:6px 1px 6px 1px;background:var(--eyebrow)'],
};
const PRICE = {
  display: 'font-family:var(--display);font-size:22px;font-weight:var(--display-weight);color:var(--ink)',
  body: 'font-size:18px;font-weight:700;color:var(--ink)',
  neon: 'font-family:var(--display);font-size:24px;font-weight:700;color:var(--accent)',
};
const LOGO = {
  arch: 'border-radius:19px 19px 4px 4px',
  circle: 'border-radius:999px',
  brutal: 'border-radius:12px;border:2px solid var(--ink);box-shadow:2px 2px 0 var(--ink)',
  square: 'border-radius:10px',
  leaf: 'border-radius:20px 6px 20px 6px',
};
const OFF_TAG = {
  flat: 'border-radius:3px',
  pill: 'border-radius:999px',
  tilted: 'border-radius:8px;border:1.5px solid var(--ink);transform:rotate(-4deg)',
  code: 'border-radius:4px;font-family:var(--mono)',
};

function pattern(name, c) {
  switch (name) {
    case 'blush': return `radial-gradient(circle at 85% 4%,${mix(c.accent, c.ground, 0.35)} 0 90px,transparent 91px),radial-gradient(circle at 6% 30%,${mix(c.accent, c.ground, 0.2)} 0 60px,transparent 61px)`;
    case 'dots': return `radial-gradient(${rgba(c.primary, 0.1)} 1.4px,transparent 1.6px) 0 0/18px 18px`;
    case 'grid': return `linear-gradient(${rgba(c.ink, 0.035)} 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,${rgba(c.ink, 0.035)} 1px,transparent 1px) 0 0/24px 24px`;
    case 'linen': return `repeating-linear-gradient(0deg,${rgba(c.ink, 0.025)} 0 1px,transparent 1px 5px),repeating-linear-gradient(90deg,${rgba(c.ink, 0.02)} 0 1px,transparent 1px 7px)`;
    default: return 'none';
  }
}

/** SVG path data for the heading flourish and the seal's icon, by slot name. Fixed strings only. */
export const FLOURISH_PATHS = Object.freeze({
  diamond: 'M2 7 H52 M60 7 l7 -6 l7 6 l-7 6 z M82 7 H138',
  wave: 'M2 8 C16 1 26 13 40 7 S64 1 78 7 S102 13 116 7 S132 3 138 6',
  squiggle: 'M2 9 Q9 1 16 9 T30 9 T44 9 T58 9 T72 9 T86 9 T100 9',
  arrow: 'M2 7 H138 M2 7 l6 -5 M2 7 l6 5',
  vine: 'M2 10 C30 10 40 2 70 6 S110 12 138 4 M70 6 c-4 -5 -2 -6 4 -5',
  line: 'M2 7 H138',
});
export const SEAL_ICON_PATHS = Object.freeze({
  diamond: 'M52 40 l7 12 l-7 12 l-7 -12 z',
  drop: 'M52 40 c6 8 9 12 9 16 a9 9 0 0 1 -18 0 c0 -4 3 -8 9 -16 z',
  pot: 'M44 58 h16 M46 58 c0 -8 12 -8 12 0 M48 48 c0 -3 3 -3 3 -6 M54 48 c0 -3 3 -3 3 -6',
  bolt: 'M55 38 L45 54 h8 l-4 12 l12 -18 h-8 z',
  leaf: 'M52 64 V46 M52 52 c-8 -2 -10 -8 -10 -12 c6 0 10 4 10 12 M52 50 c6 -2 9 -6 9 -10 c-5 0 -9 3 -9 10',
  star: 'M52 40 l3.5 7.5 8 1 -6 5.5 1.5 8 -7 -4 -7 4 1.5 -8 -6 -5.5 8 -1 z',
});

const pick = (table, name, fallback) => (Object.hasOwn(table, name) ? table[name] : table[fallback]);

/** The page's whole stylesheet: the shared structure, then this theme's tokens and slots. */
export function themeCss(theme) {
  const c = theme.colors;
  const s = theme.slots;
  const radius = Number.isInteger(s.radius) && s.radius >= 0 && s.radius <= 999 ? s.radius : 8;
  const weight = [400, 500, 600, 700, 800].includes(s.displayWeight) ? s.displayWeight : 700;
  const [photo, thumb, photoExtra] = pick(PHOTO, s.photoShape, 'rounded');
  const [tickerBox, tickerText, tickerDot] = pick(TICKER, s.ticker, 'rule');
  const vars = [
    ...Object.entries(c).map(([k, v]) => `--${k.replace('_', '-')}:${v}`),
    `--chip:${mix(c.primary, c.ground, 0.08)}`,
    `--frame-bg:${mix(c.primary, c.ink, 0.35)}`,
    `--line-strong:${mix(c.line, c.ink, 0.6)}`,
    `--shadow:${rgba(c.primary, 0.55)}`,
    `--glow:${rgba(c.accent, 0.35)}`,
    `--display:${fontStack(theme.headingFont, SANS)}`,
    `--body:${fontStack(theme.bodyFont, SANS)}`,
    '--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    `--display-weight:${weight}`,
    `--r-btn:${radius}px`,
    `color-scheme:${theme.scheme === 'dark' ? 'dark' : 'light'}`,
  ];
  return [
    `:root{${vars.join(';')}}`,
    BASE_CSS,
    `.ground{background:${pattern(s.pattern, c)}}`,
    `.frame{${pick(FRAME, s.reelFrame, 'plain')}}`,
    `.photo{border-radius:${photo};${photoExtra}}.thumb{border-radius:${thumb}}`,
    `.card{${pick(CARD, s.cardStyle, 'plain')}}`,
    `.btn{${pick(BUTTON, s.buttonStyle, 'solid')}${s.buttonCase === 'upper' ? ';text-transform:uppercase;letter-spacing:.14em;font-size:12px' : ''}}`,
    `.hl{${pick(HIGHLIGHT, s.highlight, 'color')}}`,
    `.ticker{${tickerBox}}.ticker span{${tickerText}}.ticker i{${tickerDot}}`,
    `.price{${pick(PRICE, s.priceStyle, 'body')}}`,
    `.logo{${pick(LOGO, s.logoShape, 'circle')}}`,
    `.off{${pick(OFF_TAG, s.offTag, 'pill')}}`,
    s.labelStyle === 'code' ? '.kicker,.eyebrow{font-family:var(--mono)}' : '',
  ].join('');
}

/** The Google Fonts stylesheet for the theme's two fonts (both are on the allow-list). */
export const themeFontsHref = (theme) => brandFontsHref({ headingFont: theme.headingFont, bodyFont: theme.bodyFont });

// The structure every buyer page shares, ported from the "Reel page template" design: one column, phone first, 44 px targets.
const BASE_CSS = [
  '*,*::before,*::after{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.5;position:relative;min-height:100vh}',
  'img,video{max-width:100%;display:block}',
  'a{color:inherit}',
  ':focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
  '.ground{position:absolute;inset:0;pointer-events:none;z-index:0}',
  '.page{position:relative;z-index:1;max-width:560px;margin:0 auto;padding-bottom:40px}',
  '.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:8px;z-index:9;background:var(--card);padding:8px 12px}',
  '.site-header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 20px}',
  '.brand{display:flex;align-items:center;gap:10px;text-decoration:none;min-height:44px}',
  '.logo{width:38px;height:38px;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;font-weight:700;font-size:13px;letter-spacing:.06em;background:var(--primary);color:var(--on-primary)}',
  '.logo img{width:100%;height:100%;object-fit:contain;background:var(--card)}',
  '.brand-name{font-family:var(--display);font-weight:var(--display-weight);font-size:20px;letter-spacing:-.01em}',
  '.chip{min-width:44px;min-height:44px;border-radius:999px;background:var(--chip);display:inline-flex;align-items:center;justify-content:center;text-decoration:none;padding:0 14px;font-weight:600;font-size:14px}',
  '.hero{padding:8px 20px 0;display:flex;flex-direction:column;gap:18px}',
  '.eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--eyebrow)}',
  'h1,h2,h3{margin:0}',
  '.hero h1{font-family:var(--display);font-weight:var(--display-weight);font-size:clamp(34px,11vw,46px);line-height:1.02;letter-spacing:-.02em}',
  '.stage{position:relative;height:400px}',
  '.frame{position:absolute;left:30px;right:30px;top:0;height:380px;overflow:hidden;background:var(--frame-bg)}',
  '.frame img,.frame video{width:100%;height:100%;object-fit:cover}',
  '.play{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);width:72px;height:72px;border-radius:999px;background:#FFFFFF;display:flex;align-items:center;justify-content:center;box-shadow:0 14px 30px -12px rgba(0,0,0,.45)}',
  '.tag{position:absolute;display:flex;align-items:center;gap:6px}.tag:nth-of-type(1){left:6px;top:96px}.tag:nth-of-type(2){left:40%;top:250px}',
  '.tag b{width:14px;height:14px;border-radius:999px;background:var(--accent);border:3px solid #FFFFFF;box-shadow:0 0 0 1px rgba(0,0,0,.15)}',
  '.tag span{font-size:13px;font-weight:700;padding:7px 12px;border-radius:999px;background:var(--card);color:var(--ink);box-shadow:0 8px 20px -10px rgba(0,0,0,.5);white-space:nowrap}',
  '.seal{position:absolute;right:6px;bottom:30px;transform:rotate(-12deg);width:104px;height:104px}',
  '.seal circle{fill:var(--accent)}.seal text{fill:var(--on-accent);font-family:var(--body);font-size:10.5px;font-weight:700;letter-spacing:2.2px;text-transform:uppercase}.seal path{fill:none;stroke:var(--on-accent);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
  '.ticker{margin:36px 0 28px;overflow:hidden}',
  '.ticker div{display:flex;gap:14px;white-space:nowrap;padding:12px 20px;font-size:13px;font-weight:600}',
  '.ticker span{display:flex;align-items:center;gap:14px}.ticker i{width:6px;height:6px;flex:none}',
  '.section{padding:8px 20px 0;display:flex;flex-direction:column;gap:14px}.section+.section{padding-top:36px}',
  '.kicker{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}',
  '.section h2{font-family:var(--display);font-weight:var(--display-weight);font-size:28px;letter-spacing:-.01em}',
  '.flourish{fill:none;stroke:var(--primary);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
  '.card{display:flex;gap:14px;padding:14px;background:var(--card);color:var(--ink)}',
  '.photo{flex:none;position:relative;width:96px;height:116px;overflow:hidden;background:var(--chip)}',
  '.photo img{width:100%;height:100%;object-fit:cover}',
  '.photo .num{position:absolute;left:8px;bottom:8px;font-size:12px;font-weight:700;color:var(--on-primary);background:var(--primary);border-radius:999px;padding:3px 8px}',
  '.card-body{display:flex;flex-direction:column;gap:8px;flex:1;min-width:0}',
  '.card h3{font-size:15px;font-weight:600;line-height:1.35;max-height:40px;overflow:hidden}',
  '.prices{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.mrp{font-size:13px;color:var(--muted);text-decoration:line-through}',
  '.off{font-size:12px;font-weight:700;padding:3px 8px;background:var(--accent);color:var(--on-accent)}',
  '.sold{font-size:13px;font-weight:700;color:var(--muted)}',
  '.card.is-sold{opacity:.72}',
  '.btn{align-self:flex-start;min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 18px;border-radius:var(--r-btn);font:inherit;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer}',
  '.btn-quiet{align-self:flex-start;min-height:44px;display:inline-flex;align-items:center;gap:8px;padding:0 4px;font-weight:600;color:var(--ink)}',
  '.strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:12px}',
  '.strip a{display:flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;font-size:13px;font-weight:600;text-align:center;line-height:1.25}',
  '.thumb{width:72px;height:72px;padding:3px;border:2px solid var(--primary);overflow:hidden;background:var(--chip)}',
  '.thumb img{width:100%;height:100%;object-fit:cover;border-radius:inherit}',
  '.trust{margin:32px 20px 0;padding-top:20px;border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;text-align:center}',
  '.trust div{display:flex;flex-direction:column;align-items:center;gap:8px;font-size:13px;font-weight:600;line-height:1.3}',
  '.trust svg{fill:none;stroke:var(--primary);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
  '.site-footer{margin:28px 20px 0;display:flex;flex-direction:column;gap:12px;font-size:14px;color:var(--muted)}',
  '.outline-btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;border-radius:var(--r-btn);border:1.5px solid var(--ink);color:var(--ink);text-decoration:none;font-weight:600}',
  '.form{display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:12px}',
  '.form label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600}',
  '.form input[type=text],.form input[type=tel],.form input[type=email],.form input[type=search]{min-height:44px;padding:0 12px;border:1.5px solid var(--line-strong);border-radius:8px;background:var(--ground);color:var(--ink);font:inherit}',
  '.form .check{flex-direction:row;align-items:flex-start;gap:10px;font-weight:400}.form .check input{width:22px;height:22px;flex:none;margin-top:2px}',
  '.form .error{color:var(--primary);font-weight:700;font-size:14px}',
  '.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
  '.notice{padding:48px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px}',
  '.notice h1{font-family:var(--display);font-weight:var(--display-weight);font-size:32px}',
  '@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}',
].join('');
