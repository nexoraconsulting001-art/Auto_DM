/** Pure rules of the sign-up flow (PRD 5.20): which screen the server's status puts the person on, and the checks the forms make first. */
export const ACCOUNT_TYPES = Object.freeze(['creator', 'seller']);
export const SIGNUP_STEPS = Object.freeze(['opened', 'signed_in', 'account_type', 'instagram_connected', 'automation_drafted', 'automation_live', 'finished']);

export const TYPE_COPY = Object.freeze({
  creator: { title: 'Creator', text: 'Turn comments on your reels into DMs with your links. No shop needed.' },
  seller: { title: 'Seller', text: 'Sell from your reels with a shop, orders and shipping, as well as the DMs.' },
});

/** Which screen to show: the server's `next` step decides, and a finished run shows the end. */
export function screenFor(status) {
  if (!status) return 'loading';
  if (!status.signedIn) return 'signin';
  if (!status.open && !status.tenantId) return 'closed';
  const done = new Set(status.steps.map((entry) => entry.step));
  if (done.has('finished')) return 'done';
  if (!status.tenantId || !done.has('account_type')) return 'type';
  if (!done.has('instagram_connected')) return 'instagram';
  if (!done.has('automation_live')) return 'automation';
  return 'finish';
}

export const STEP_LABELS = Object.freeze([
  ['type', 'Your account'],
  ['instagram', 'Connect Instagram'],
  ['automation', 'First automation'],
  ['finish', 'Go live'],
]);

export function checkStart({ accountType, name }) {
  const found = {};
  if (!ACCOUNT_TYPES.includes(accountType)) found.accountType = 'Choose Creator or Seller.';
  if (!String(name ?? '').trim()) found.name = 'Enter a name.';
  else if (String(name).trim().length > 120) found.name = 'Use 120 characters or fewer.';
  return found;
}

export function checkAutomation({ mediaId, keyword, link }) {
  const found = {};
  if (!/^\d{1,40}$/.test(String(mediaId ?? ''))) found.mediaId = 'Pick a reel.';
  if (!String(keyword ?? '').trim()) found.keyword = 'Enter a keyword.';
  else if (String(keyword).trim().length > 40) found.keyword = 'Use 40 characters or fewer.';
  if (!/^https:\/\/\S+$/i.test(String(link ?? '').trim())) found.link = 'Enter the link to send, starting with https://';
  return found;
}

/** The server's problems (by field) as messages for the form's own fields. `reason` words are the server's. */
export function problemsByField(problems = []) {
  const out = {};
  for (const problem of problems) out[problem.field] ??= problem.message;
  return out;
}

export const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
