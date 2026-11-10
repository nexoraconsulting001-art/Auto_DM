import { matchesKeywords } from '../automations/match.js';

/**
 * Bhava's word lists (PRD 4.6, 4.8, 6.4). Owners add to them through tenant_words and can never remove a base word, because
 * a base word lives here in code. English, Hindi and Hinglish. Words stay lowercase and NFC.
 */
export const BASE_WORDS = Object.freeze({
  optout: Object.freeze(['stop', 'unsubscribe', 'band karo', 'mat bhejo', 'बंद करो']),
  negative: Object.freeze([
    // Complaints and abuse
    'complaint', 'complaints', 'complain', 'complained', 'worst', 'pathetic', 'horrible', 'terrible', 'disgusting', 'useless', 'rubbish', 'garbage', 'waste of money',
    'idiot', 'stupid', 'fuck', 'fucking', 'shit', 'bastard', 'chutiya', 'bhosdike', 'madarchod', 'behenchod', 'harami', 'kamina', 'kutta',
    // Scam and fraud claims
    'scam', 'scammer', 'scammers', 'scamming', 'fraud', 'fraudster', 'fraudsters', 'fraudulent', 'fake', 'cheat', 'cheated', 'cheating', 'cheater', 'cheaters', 'dhokha', 'dhoka', 'dhokebaaz', 'dhokhebaaz', 'dhokebaz', 'thagi', 'thag', 'farzi', 'nakli', 'chor', 'chori', 'loot', 'lootera', 'looters',
    // Refunds and "not received"
    'refund', 'refunds', 'money back', 'paisa wapas', 'paise wapas', 'paisa vapas', 'paise vapas', 'not received', 'never received', 'didn\'t receive', 'did not receive', 'haven\'t received', 'have not received', 'not delivered', 'never delivered', 'never arrived', 'nahi mila', 'nahin mila', 'nhi mila', 'nahi aaya', 'nahin aaya', 'nhi aaya', 'nahi aya', 'ghatiya', 'bekar', 'bekaar', 'bakwas', 'bakwaas', 'shikayat',
    // Legal threats
    'lawsuit', 'sue you', 'legal action', 'legal notice', 'lawyer', 'advocate', 'consumer court', 'consumer forum', 'police complaint', 'cyber cell', 'cyber crime', 'court case',
    // Hindi
    'शिकायत', 'धोखा', 'धोखाधड़ी', 'ठगी', 'ठग', 'फर्जी', 'फ़र्ज़ी', 'नकली', 'चोर', 'लूट', 'रिफंड', 'पैसे वापस', 'पैसा वापस', 'नहीं मिला', 'नहीं आया', 'घटिया', 'बेकार', 'बकवास', 'कानूनी नोटिस', 'वकील', 'पुलिस', 'कोर्ट',
  ]),
  handoff: Object.freeze(['human', 'agent', 'representative', 'real person', 'customer care', 'customer support', 'talk to someone', 'talk to owner', 'speak to someone', 'call me', 'insaan', 'owner se baat', 'baat karni hai', 'इंसान', 'मालिक से बात', 'बात करनी है']),
});

/** The one word that lifts an opt-out (PRD 4.6). It can't be changed by a business. */
export const START_WORDS = Object.freeze(['start']);

const fold = (s) => String(s).normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

/** How a word is stored and compared: NFC, folded, single-spaced. */
export const normalizeWord = (s) => fold(s).trim().replace(/\s+/g, ' ');

/** PRD 4.6: true when the whole DM or comment is one of the opt-out words, in any case. "Please stop" is not, and neither is "stop.". */
export const isOptOut = (text, added = []) => {
  const whole = normalizeWord(text);
  return Boolean(whole) && [...BASE_WORDS.optout, ...added].some((w) => normalizeWord(w) === whole);
};

export const isStart = (text) => START_WORDS.includes(normalizeWord(text));

/** PRD 4.8: complaints, abuse, fraud claims, refunds, "not received" and legal threats, wherever they appear in the text. */
export const hasNegativeIntent = (text, added = []) => matchesKeywords(text, [...BASE_WORDS.negative, ...added]);

export const wantsHuman = (text, added = []) => matchesKeywords(text, [...BASE_WORDS.handoff, ...added]);

/** PRD 4.8: emoji-only, or under 2 characters. The caller makes the exception for an emoji keyword. */
export function isTooShort(text) {
  const compact = String(text).replace(/\s+/gu, '');
  return [...compact].length < 2 || !/[\p{L}\p{N}]/u.test(compact);
}
