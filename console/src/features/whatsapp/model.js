/** Pure rules of the WhatsApp screen (PRD 6.12): keyword sets as the form holds them, the checks, and the words for the account's state. */
export const LIMITS = Object.freeze({ keywordSets: 50, keywordsPerSet: 20, keywordChars: 40, messageChars: 1000 });
export const OPTIN_PURPOSES = Object.freeze(['marketing', 'order_updates']);
export const PURPOSE_WORDS = Object.freeze({ marketing: 'Offers and news', order_updates: 'Order updates' });
export const SOURCE_WORDS = Object.freeze({ keyword: 'Sent a keyword', checkout: 'At checkout', account: 'In their account', form: 'On a form', seller: 'Added by you', import: 'Imported' });

export const STATUS_WORDS = Object.freeze({
  active: { label: 'Connected', tone: 'good' },
  reconnect: { label: 'Needs reconnecting', tone: 'warn' },
  disabled: { label: 'Disabled by WhatsApp', tone: 'bad' },
});

export const blankSet = () => ({ key: Math.random().toString(36).slice(2), id: undefined, keywordsText: '', target: 'link', reelId: '', linkUrl: '', message: '', active: true });

export const fromServer = (set) => ({
  key: String(set.id), id: set.id, keywordsText: set.keywords.join(', '), target: set.reelId ? 'reel' : 'link', reelId: set.reelId ? String(set.reelId) : '', linkUrl: set.linkUrl, message: set.message, active: set.active,
});

export const splitKeywords = (text) => [...new Set(text.split(/[,\n]/).map((word) => word.trim()).filter(Boolean))];

/** The body one set sends: exactly one of a reel or a link, as the server requires. */
export const toServer = (set) => ({
  ...(set.id ? { id: set.id } : {}),
  keywords: splitKeywords(set.keywordsText),
  reelId: set.target === 'reel' ? Number(set.reelId) : null,
  linkUrl: set.target === 'link' ? set.linkUrl.trim() : '',
  message: set.message.trim(),
  active: set.active,
});

/** Problems by set position and field, found before anything is sent. */
export function checkSets(sets) {
  const found = {};
  if (sets.length > LIMITS.keywordSets) found.list = `Use ${LIMITS.keywordSets} keyword sets or fewer.`;
  sets.forEach((set, index) => {
    const keywords = splitKeywords(set.keywordsText);
    if (!keywords.length) found[`${index}.keywords`] = 'Add a keyword.';
    else if (keywords.length > LIMITS.keywordsPerSet) found[`${index}.keywords`] = `Use ${LIMITS.keywordsPerSet} keywords or fewer.`;
    else if (keywords.some((word) => word.length > LIMITS.keywordChars)) found[`${index}.keywords`] = `Keep each keyword to ${LIMITS.keywordChars} characters.`;
    if (set.target === 'reel' && !/^\d+$/.test(set.reelId)) found[`${index}.reelId`] = 'Pick a reel.';
    if (set.target === 'link' && !/^https:\/\/\S+$/i.test(set.linkUrl.trim())) found[`${index}.linkUrl`] = 'Use an https link.';
    if (set.message.length > LIMITS.messageChars) found[`${index}.message`] = `Use ${LIMITS.messageChars} characters or fewer.`;
  });
  return found;
}

export function move(list, from, to) {
  if (to < 0 || to >= list.length) return list;
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}
