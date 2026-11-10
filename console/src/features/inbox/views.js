/** Pure: the words and rules of the inbox screens. */

export const THREAD_FILTERS = Object.freeze([
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'needs_human', label: 'Waiting for you' },
  { value: 'closed', label: 'Closed' },
]);

export const THREAD_STATUS = Object.freeze({
  open: { label: 'Open', tone: 'neutral' },
  needs_human: { label: 'Waiting for you', tone: 'warn' },
  closed: { label: 'Closed', tone: 'neutral' },
});

export const NEEDS_HUMAN_KIND = Object.freeze({
  negative_comment: 'Unhappy comment',
  handoff: 'Asked for a person',
  send_failed: 'A message failed',
  unknown_outcome: 'Not confirmed',
  why_no_dm: 'Why no DM?',
});

export const MESSAGE_KIND = Object.freeze({ story_reply: 'Replied to your story', story_mention: 'Mentioned you in a story', postback: 'Tapped a button', attachment: 'Sent an attachment' });

export const AUTHOR_LABEL = Object.freeze({ person: '', automation: 'Automation', owner: 'You' });

export const SENT_OUTCOMES = Object.freeze(['sent', 'sent_fallback']);

export const handle = (username) => (username ? `@${username}` : 'Instagram user');

/** The reason a chat isn't being answered automatically. '' when it is. */
export function pauseLine(thread, formatWhen) {
  if (!thread.automationPausedUntil) return '';
  const until = formatWhen(thread.automationPausedUntil);
  if (thread.pauseReason === 'thread.handoff') return `They asked for a person, so automation is paused here until ${until}.`;
  if (thread.pauseReason === 'thread.owner_replied') return `You replied, so automation is paused here until ${until}.`;
  return `Automation is paused here until ${until}.`;
}
