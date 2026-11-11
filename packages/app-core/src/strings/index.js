/**
 * Strings, ready for Hindi. A catalogue is { locale: { key: text } }; apps add their own beside the shared one:
 *
 *   const strings = createStrings({ en: { ...shared.en, ...mine.en }, hi: { ...shared.hi, ...mine.hi } }, { locale: deviceLocale() });
 *   strings.t('update.body', { app: 'My app' });
 *
 * A key the locale lacks falls back to English, and one English lacks comes back as the key, so a gap shows in review
 * and never crashes a screen. `checkCatalogue` is what tests run: same keys and same {braces} in every language.
 */
import { createContext, createElement, useContext, useMemo, useSyncExternalStore } from 'react';
import en from './en.js';
import hi from './hi.js';

export const shared = Object.freeze({ en, hi });
export const LOCALES = Object.freeze(['en', 'hi']);
const FALLBACK = 'en';

/** 'hi-IN' and 'hi' are Hindi; anything this build has no words for is English. */
export const pickLocale = (tag, available = LOCALES) => {
  const base = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
  return available.includes(base) ? base : FALLBACK;
};

export function createStrings(catalogue = shared, { locale = FALLBACK } = {}) {
  let current = pickLocale(locale, Object.keys(catalogue));
  const listeners = new Set();
  const t = (key, values = {}) => {
    const text = catalogue[current]?.[key] ?? catalogue[FALLBACK]?.[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined || values[name] === null ? whole : String(values[name])));
  };
  return {
    t,
    getLocale: () => current,
    setLocale(next) {
      current = pickLocale(next, Object.keys(catalogue));
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Problems in a catalogue, as sentences: a key one language lacks, or a {brace} that differs. Empty when sound. */
export function checkCatalogue(catalogue) {
  const problems = [];
  const base = catalogue[FALLBACK] ?? {};
  const braces = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [locale, lines] of Object.entries(catalogue)) {
    if (locale === FALLBACK) continue;
    for (const key of Object.keys(base)) {
      if (!(key in lines)) problems.push(`${locale} has no line for "${key}"`);
      else if (braces(lines[key]) !== braces(base[key])) problems.push(`${locale} "${key}" fills different {words} than English`);
    }
    for (const key of Object.keys(lines)) if (!(key in base)) problems.push(`${locale} has "${key}", which English lacks`);
  }
  for (const [key, text] of Object.entries(base)) if (typeof text !== 'string' || !text.trim()) problems.push(`English "${key}" is empty`);
  return problems;
}

const StringsContext = createContext(createStrings());

export const StringsProvider = ({ strings, children }) => createElement(StringsContext.Provider, { value: strings }, children);

/** `const { t } = useStrings()`: re-renders when the language changes. */
export function useStrings() {
  const strings = useContext(StringsContext);
  const locale = useSyncExternalStore(strings.subscribe, strings.getLocale, strings.getLocale);
  return useMemo(() => ({ t: strings.t, locale, setLocale: strings.setLocale }), [strings, locale]);
}
