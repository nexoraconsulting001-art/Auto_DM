/** Pure: what happened to a comment (activity.list's `result`), as a badge. An unknown result is shown as it is, never hidden. */
export const RESULT_TONES = Object.freeze({
  sent: 'good',
  processing: 'primary',
  error: 'bad',
  'skip:no-keyword': 'neutral',
  'skip:unmapped-reel': 'neutral',
  'skip:own-comment': 'neutral',
  'skip:already-sent-to-user': 'neutral',
  'skip:duplicate-comment': 'neutral',
  'skip:malformed': 'neutral',
  'skip:not-connected': 'warn',
  'skip:capped': 'neutral',
  'skip:too-short': 'neutral',
});

export const RESULT_CODES = Object.freeze(Object.keys(RESULT_TONES));

/** { label, tone } with `t` from useStrings(). */
export function describeResult(t, result) {
  if (Object.hasOwn(RESULT_TONES, String(result ?? ''))) return { label: t(`activity.result.${result}`), tone: RESULT_TONES[result] };
  return { label: String(result ?? ''), tone: 'neutral' };
}

/** "@name", or a neutral word when Instagram did not say who. Shown on screen only; never written to a log. */
export const handleOf = (t, username) => (username ? `@${username}` : t('activity.someone'));
