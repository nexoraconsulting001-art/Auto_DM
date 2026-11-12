/**
 * The shell's own lines, and every feature's lines joined to them. No line names a business or the platform: where a
 * brand's name is shown it is passed in as {brand} from the build's brand.
 */
export const shellStrings = Object.freeze({
  en: Object.freeze({
    'pending.body': 'This part of the app is on its way.',
    'shell.tabs': 'Main menu',
    'shell.noBrand.title': 'This build is not set up',
    'shell.noBrand.body': 'It was made without a store. Please install the app again from the store.',
  }),
  hi: Object.freeze({
    'pending.body': 'ऐप का यह हिस्सा जल्द आ रहा है।',
    'shell.tabs': 'मुख्य मेनू',
    'shell.noBrand.title': 'यह ऐप तैयार नहीं है',
    'shell.noBrand.body': 'इसे किसी स्टोर के बिना बनाया गया था। कृपया ऐप को स्टोर से दोबारा इंस्टॉल करें।',
  }),
});

/** One catalogue from the shell's lines and each feature's: { en: {...}, hi: {...} }. A later feature never replaces an earlier key. */
export function catalogueOf(features) {
  const out = { en: { ...shellStrings.en }, hi: { ...shellStrings.hi } };
  for (const feature of features) {
    for (const locale of Object.keys(out)) {
      for (const [key, line] of Object.entries(feature.strings?.[locale] ?? {})) if (!(key in out[locale])) out[locale][key] = line;
    }
  }
  return out;
}
