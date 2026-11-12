/** Pure: the words and rules of the inbox screens, as string keys. The same rules as the console's inbox. */

export const THREAD_FILTERS = Object.freeze(['', 'open', 'needs_human', 'closed']);
export const THREAD_TONES = Object.freeze({ open: 'neutral', needs_human: 'warn', closed: 'neutral' });
export const NEEDS_HUMAN_KINDS = Object.freeze(['negative_comment', 'handoff', 'send_failed', 'unknown_outcome', 'why_no_dm']);
export const MESSAGE_KINDS = Object.freeze(['story_reply', 'story_mention', 'postback', 'attachment']);
export const SENT_OUTCOMES = Object.freeze(['sent', 'sent_fallback']);
export const WINDOW_CLOSED = 'window.closed';
export const COMMENT_ID_MAX = 80;

/** "@name", or a neutral word when Instagram did not say who. */
export const handle = (t, username) => (username ? `@${username}` : t('inbox.someone'));

/** The line that says why a chat is not answered automatically, or '' when it is. */
export function pauseLine(t, thread, when) {
  if (!thread.automationPausedUntil) return '';
  const values = { until: when(thread.automationPausedUntil) };
  if (thread.pauseReason === 'thread.handoff') return t('inbox.paused.handoff', values);
  if (thread.pauseReason === 'thread.owner_replied') return t('inbox.paused.owner', values);
  return t('inbox.paused.other', values);
}

/** A comment id as the lookup takes it: trimmed, at most 80 characters, and only characters a comment id has. */
export const cleanCommentId = (typed) => String(typed ?? '').trim().slice(0, COMMENT_ID_MAX);
export const isCommentId = (id) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
