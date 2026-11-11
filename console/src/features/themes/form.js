import { THEME_TEXT } from '../catalog/shared/limits.js';

const PLAIN = /^[^<>{}\0]*$/;

/** The seller's own seal words and ticker lines (F-106), as the form holds them. */
export const themeToText = (theme) => ({ sealText: theme.sealText ?? '', tickerItems: [...(theme.tickerItems ?? [])] });

/** The words as the API takes them (ThemeText), or `errors` by field. Empty keeps the look's own words. */
export function textBody(form) {
  const errors = {};
  const sealText = form.sealText.trim();
  if (sealText.length > THEME_TEXT.sealText) errors.sealText = `Use ${THEME_TEXT.sealText} characters or fewer`;
  else if (!PLAIN.test(sealText)) errors.sealText = 'Use plain words only';
  const tickerItems = form.tickerItems.map((item) => item.trim()).filter(Boolean);
  if (tickerItems.length > THEME_TEXT.tickerItems) errors.tickerItems = `Use at most ${THEME_TEXT.tickerItems} lines`;
  else if (tickerItems.some((item) => item.length > THEME_TEXT.tickerItem)) errors.tickerItems = `Keep each line to ${THEME_TEXT.tickerItem} characters`;
  else if (tickerItems.some((item) => !PLAIN.test(item))) errors.tickerItems = 'Use plain words only';
  if (Object.keys(errors).length) return { errors };
  return { body: { sealText, tickerItems } };
}

/** A website to read a look from (8.9): "yourshop.com" or its full link. The server adds https:// and checks the rest. */
export function siteBody(text) {
  const website = String(text ?? '').trim();
  if (!website) return { error: 'Enter your website' };
  if (/[\s\0]/.test(website) || !website.includes('.') || website.length < 4) return { error: 'Enter an address like yourshop.com' };
  if (website.length > 500) return { error: 'That address is too long' };
  return { body: { website } };
}

const SITE_STATE = {
  read: { tone: 'good', badge: 'Read', title: 'We read your website’s look', text: 'Check the colours and fonts below, then use them.', usable: true },
  script_only: { tone: 'warn', badge: 'Partly read', title: 'We could only read part of it', text: 'Your website draws itself with scripts, so we could read little. Our team will take a look. You can pick a look below meanwhile.', usable: true },
  failed: { tone: 'bad', badge: 'Not read', title: 'We couldn’t read that website', text: 'Check the address, or pick a look below instead.', usable: false },
  blocked: { tone: 'bad', badge: 'Not allowed', title: 'We can’t read that address', text: 'Use your shop’s public website address.', usable: false },
};
/** One read of a website, as the screen shows it. A read with no colours can't be used. */
export function siteReadView(read) {
  const state = SITE_STATE[read.status] ?? SITE_STATE.failed;
  const hasLook = Object.values(read.colors ?? {}).some(Boolean);
  return { ...state, usable: state.usable && hasLook, applied: Boolean(read.appliedAt) };
}

/** Where the accent colour came from, in the owner's words (F-104). */
const ACCENT_FROM = { logo: 'Accent colour tuned from your logo.', profile_photo: 'Accent colour tuned from your Instagram photo.', website: 'Accent colour taken from your website.' };
export const accentNote = (theme) => ACCENT_FROM[theme.accentFrom] ?? '';

// ---- drawing a look in miniature ---------------------------------------------------------------------------------------------
// A preset's slots are names, never CSS (F-107), so the console draws its small preview from the same names. An unknown name falls
// back to a plain shape: a look added later still shows, as a row of data, with no change here.

const FRAME = { arch: '40px 40px 3px 3px', dewdrop: '58% 42% 52% 48% / 44% 56% 44% 56%', tilted: '10px', screen: '12px', pebble: '40px 8px 40px 8px', plain: '8px' };
const PHOTO = { arch: '12px 12px 2px 2px', circle: '999px', outlined: '6px', rounded: '8px', leaf: '12px 3px 12px 3px', square: '0' };

const radiusOf = (slots) => `${Math.min(Math.max(Number(slots?.radius) || 0, 0), 999)}px`;

/** The inline styles of a look's miniature and preview, from its colours, fonts and slots. */
export function lookStyles(look) {
  const colors = look.colors ?? {};
  const slots = look.slots ?? {};
  const button = { background: colors.primary, color: colors.on_primary, borderRadius: slots.buttonStyle === 'pill' ? '999px' : radiusOf(slots), textTransform: slots.buttonCase === 'upper' ? 'uppercase' : 'none' };
  if (slots.buttonStyle === 'hard_shadow') button.boxShadow = `3px 3px 0 ${colors.ink}`;
  if (slots.buttonStyle === 'outline') Object.assign(button, { background: 'transparent', color: colors.primary, border: `2px solid ${colors.primary}` });
  return {
    page: { background: colors.ground, color: colors.ink, borderColor: colors.line },
    hero: { background: colors.primary, color: colors.on_primary, borderRadius: FRAME[slots.reelFrame] ?? FRAME.plain, transform: slots.reelFrame === 'tilted' ? 'rotate(-3deg)' : undefined, fontWeight: slots.displayWeight ?? 700 },
    photo: { background: colors.accent, borderRadius: PHOTO[slots.photoShape] ?? PHOTO.rounded },
    line: { background: colors.ink },
    card: { background: colors.card, borderColor: colors.line, borderRadius: radiusOf(slots) },
    muted: { color: colors.muted },
    eyebrow: { color: colors.eyebrow },
    button,
    seal: { background: colors.accent, color: colors.on_accent },
    title: { fontWeight: slots.displayWeight ?? 700, fontStyle: slots.highlight === 'italic' ? 'italic' : 'normal' },
  };
}

/** The words a look shows: the seller's own where set, the preset's otherwise. */
export function lookWords(look, own = {}) {
  const slots = look.slots ?? {};
  const ticker = own.tickerItems?.length ? own.tickerItems : slots.tickerItems ?? [];
  return { seal: own.sealText || slots.sealText || '', ticker };
}
