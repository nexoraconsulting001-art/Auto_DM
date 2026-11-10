/** What happened to a comment, in words a seller reads. An unknown result is shown as it is rather than hidden. */
const RESULTS = Object.freeze({
  sent: { label: 'DM sent', tone: 'good' },
  processing: { label: 'Sending', tone: 'neel' },
  error: { label: 'Failed', tone: 'bad' },
  'skip:no-keyword': { label: 'No keyword', tone: 'neutral' },
  'skip:unmapped-reel': { label: 'Reel not set up', tone: 'neutral' },
  'skip:own-comment': { label: 'Your own comment', tone: 'neutral' },
  'skip:already-sent-to-user': { label: 'Already sent', tone: 'neutral' },
  'skip:duplicate-comment': { label: 'Already handled', tone: 'neutral' },
  'skip:malformed': { label: 'Unreadable', tone: 'neutral' },
  'skip:not-connected': { label: 'Instagram not connected', tone: 'warn' },
});

export const describeResult = (result) => RESULTS[result] ?? { label: result, tone: 'neutral' };
