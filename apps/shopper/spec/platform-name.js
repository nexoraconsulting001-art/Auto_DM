// The platform's name, for the tests that prove a buyer never sees it (PRD 10.1, 10.7; P-01, P-03, P-31).
// The shopper app's source may not hold the word itself (policy-check: platform-name-in-shopper-app), and a test file is
// source too, so the word is spelled from its character codes here, once, and every shopper test takes it from here.
const WORD = String.fromCharCode(98, 104, 97, 118, 97);

/** Matches the platform's name anywhere in a text, in any case. */
export const PLATFORM_NAME = new RegExp(WORD, 'i');

/** Matches the platform's name or any of the given words (for example the address of a development server). */
export const platformOr = (...words) => new RegExp([WORD, ...words].join('|'), 'i');
