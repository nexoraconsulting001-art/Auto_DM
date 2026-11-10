// The words live in JSON because every reason code has to appear exactly as the API sends it.
import table from './reasons.json' with { type: 'json' };

export const OUTCOME_CODES = Object.freeze(Object.keys(table.outcomes));
export const REASON_LIST = Object.freeze(Object.keys(table.reasons));

export const isOutcome = (code) => Object.hasOwn(table.outcomes, code ?? '');
export const isReason = (code) => Object.hasOwn(table.reasons, code ?? '');

const NOTED = Object.freeze({ label: 'Noted', tone: 'neutral' });

/**
 * { label, tone } for a Badge. Some rows record an event rather than a send, and carry a reason code here: those are simply
 * noted. A code this console doesn't know yet is shown as it is rather than hidden.
 */
export function describeOutcome(code) {
  if (isOutcome(code)) return table.outcomes[code];
  return isReason(code) ? NOTED : { label: code, tone: 'neutral' };
}

/** One sentence a seller can read. Empty for "no reason". */
export const describeReason = (code) => {
  if (!code) return '';
  return isReason(code) ? table.reasons[code] : code;
};

const KINDS = Object.freeze({
  private_reply: 'Private reply',
  dm: 'DM',
  public_reply: 'Public reply',
  thread: 'Chat',
  handoff: 'Chat',
  negative_comment: 'Comment',
  optout: 'Opt-out',
  optin: 'Opt-in',
  webhook: 'From Meta',
  malformed: 'From Meta',
  undecryptable: 'From Meta',
  token: 'Connection',
  gate: 'Meta’s checks',
  pause: 'Pause',
  usage: 'Usage',
  data: 'Data request',
});

/** What kind of thing a log row is about. A kind this console doesn't know yet still reads as a word. */
export function describeKind(kind) {
  if (Object.hasOwn(KINDS, kind ?? '')) return KINDS[kind];
  const words = String(kind ?? '').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
