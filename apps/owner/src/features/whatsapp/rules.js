/** Pure rules of the WhatsApp screens: the Meta sign-up address, what comes back from it, and the keyword list's shape. */

/** Meta's own embedded sign-up page for this app and configuration. Only this address is opened, and only in the system browser. */
export function signupUrl({ appId, configId, state }) {
  if (!/^\d{5,40}$/.test(String(appId ?? '')) || !/^\d{5,40}$/.test(String(configId ?? '')) || !state) return null;
  const query = new URLSearchParams({ app_id: String(appId), config_id: String(configId), state: String(state), extras: JSON.stringify({ sessionInfoVersion: '3' }) });
  return `https://business.facebook.com/messaging/whatsapp/onboard/?${query.toString()}`;
}

/** What Meta hands back when the person finishes: the code, the state we sent and the two ids. Null when anything is missing. */
export function parseReturn(url) {
  try {
    const params = new URL(String(url)).searchParams;
    const code = params.get('code');
    const state = params.get('state');
    const wabaId = params.get('waba_id') ?? params.get('wabaId');
    const phoneNumberId = params.get('phone_number_id') ?? params.get('phoneNumberId');
    if (!code || !state || !/^\d{5,40}$/.test(wabaId ?? '') || !/^\d{5,40}$/.test(phoneNumberId ?? '')) return null;
    return { code, state, wabaId, phoneNumberId };
  } catch {
    return null;
  }
}

export const KEYWORD_LIMITS = Object.freeze({ keywordSets: 50, keywordsPerSet: 20, keywordChars: 40, messageChars: 1000 });

/** A saved set as the screen edits it: keywords as one line of text, the target as 'link' or 'reel'. */
export const toDraft = (set) => ({
  id: set.id ?? null,
  keywords: (set.keywords ?? []).join(', '),
  target: set.reelId ? 'reel' : 'link',
  reelId: set.reelId ? String(set.reelId) : '',
  linkUrl: set.linkUrl ?? '',
  message: set.message ?? '',
  active: set.active !== false,
});
export const blankDraft = () => toDraft({ keywords: [], reelId: null, linkUrl: '', message: '', active: true });

/** The body for one set, or { problems: { field: key } }. Exactly one of a reel and a link. */
export function fromDraft(draft) {
  const problems = {};
  const keywords = [...new Set(String(draft.keywords).split(/[,\n]/).map((k) => k.trim()).filter(Boolean))];
  if (keywords.length === 0) problems.keywords = 'whatsapp.keywords.needKeyword';
  if (keywords.length > KEYWORD_LIMITS.keywordsPerSet) problems.keywords = 'whatsapp.keywords.tooMany';
  if (keywords.some((k) => k.length > KEYWORD_LIMITS.keywordChars)) problems.keywords = 'whatsapp.keywords.tooLong';
  let reelId = null;
  let linkUrl = '';
  if (draft.target === 'reel') {
    reelId = Number.parseInt(draft.reelId, 10);
    if (!Number.isInteger(reelId) || reelId < 1) problems.reelId = 'whatsapp.keywords.needReel';
  } else {
    linkUrl = String(draft.linkUrl).trim();
    if (!/^https:\/\/\S+$/i.test(linkUrl)) problems.linkUrl = 'whatsapp.keywords.needLink';
  }
  if (Object.keys(problems).length) return { problems };
  return { body: { ...(draft.id ? { id: draft.id } : {}), keywords, reelId, linkUrl, message: String(draft.message).trim().slice(0, KEYWORD_LIMITS.messageChars), active: draft.active } };
}
