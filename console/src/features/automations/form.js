import { splitList } from '../../lib/lists.js';

/** Pure: the builder's form, its checks, and the shape the API wants. A test keeps these numbers equal to COMPLIANCE_LIMITS. */
export const LIMITS = Object.freeze({
  textBytes: 1000,
  buttonTitleChars: 20,
  keywordsMax: 20,
  variantsMax: 3,
  publicReplyMinVariants: 5,
  followupMinMinutes: 30,
  followupMaxMinutes: 1430,
});

export const VARIANT_LABELS = Object.freeze(['A', 'B', 'C']);

export const STATES = Object.freeze({
  draft: { label: 'Draft', tone: 'neutral' },
  test: { label: 'Test', tone: 'neel' },
  live: { label: 'Live', tone: 'good' },
  paused: { label: 'Paused', tone: 'warn' },
  archived: { label: 'Archived', tone: 'neutral' },
});

export const TRIGGERS = Object.freeze([
  { value: 'comment', label: 'Comments on a reel or post', short: 'Comments', usesMedia: true, keywords: 'required', needsLink: true },
  { value: 'story_reply', label: 'Replies to a story', short: 'Story replies', usesMedia: true, keywords: 'optional', needsLink: true },
  { value: 'story_mention', label: 'Mentions in a story', short: 'Story mentions', usesMedia: false, keywords: 'none', needsLink: true },
  { value: 'dm_keyword', label: 'A keyword in a DM', short: 'Keyword DMs', usesMedia: false, keywords: 'required', needsLink: false },
  { value: 'dm_welcome', label: 'Someone’s first DM', short: 'Welcome message', usesMedia: false, keywords: 'none', needsLink: false },
]);
export const triggerOf = (type) => TRIGGERS.find((trigger) => trigger.value === type) ?? TRIGGERS[0];

export const LINK_TYPES = Object.freeze([
  { value: 'seller_site', label: 'My website' },
  { value: 'bhava_page', label: 'My store page' },
  { value: 'amazon', label: 'Amazon' },
  { value: 'affiliate', label: 'Another affiliate link' },
  { value: 'whatsapp', label: 'WhatsApp chat' },
]);

/** Which tracking id a link type can carry (PRD 6.6). */
export const TRACKING = Object.freeze({
  amazon: { kind: 'amazon_tag', label: 'Amazon tracking ID', hint: 'One per reel, so earnings can be split by reel.' },
  affiliate: { kind: 'affiliate_sub_id', label: 'Affiliate tracking ID', hint: 'Added to the link where the network allows it.' },
});

const blankVariant = (label) => ({ label, body: '', buttonTitle: '', fallbackText: '', weight: 1, quickReplies: [] });

export function newForm() {
  return {
    name: '',
    triggerType: 'comment',
    media: [],
    anyStory: false,
    otherTriggers: [],
    matchMode: 'keywords',
    anyModeAcknowledged: false,
    keywords: [],
    keywordDraft: '',
    includeReactions: false,
    priority: '0',
    variants: [blankVariant('A')],
    linkMode: 'two_tap',
    linkType: 'seller_site',
    linkUrl: '',
    tapButtonTitle: 'Send me the link',
    linkButtonTitle: 'Open the link',
    linkMessage: '',
    trackingId: '',
    discountCode: '',
    publicReplyEnabled: false,
    followupEnabled: false,
    followupDelayMinutes: '60',
    followupText: '',
    startsAt: '',
    endsAt: '',
    dailyStart: '',
    dailyEnd: '',
    outsideHours: 'hold',
    dryRun: false,
  };
}

// ---- time: the schedule is in India time, which is the default for every business (PRD 6.8) ----

const IST = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

/** A datetime-local value, read as India time, to an ISO instant. */
export function inputToIso(value) {
  if (!value) return null;
  return `${value.length === 16 ? `${value}:00` : value}${IST_OFFSET}`;
}

/** An instant to what a datetime-local input shows, in India time. */
export function isoToInput(iso) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

// ---- the form and the API ----

const toPick = ({ id, type, channel = 'instagram', caption = '', permalink = '', thumbnailUrl = '' }) => ({ id, type, channel, caption, permalink, thumbnailUrl });

export function automationToForm(automation) {
  const hasMedia = (trigger) => Boolean(trigger.mediaId);
  return {
    ...newForm(),
    name: automation.name,
    triggerType: automation.triggerType,
    media: automation.triggers.filter(hasMedia).map((trigger) => toPick({ ...trigger, id: trigger.mediaId, type: trigger.targetType })),
    anyStory: automation.triggers.some((trigger) => trigger.targetType === 'any_story'),
    otherTriggers: automation.triggers.filter((trigger) => !hasMedia(trigger) && trigger.targetType !== 'any_story').map(({ channel, targetType }) => ({ channel, targetType })),
    matchMode: automation.matchMode,
    anyModeAcknowledged: automation.matchMode === 'any', // it was confirmed when it was saved
    keywords: automation.keywords,
    includeReactions: automation.includeReactions,
    priority: String(automation.priority),
    variants: automation.variants.map(({ label, body, buttonTitle, fallbackText, weight, quickReplies }) => ({ label, body, buttonTitle, fallbackText, weight, quickReplies })),
    linkMode: automation.linkMode,
    linkType: automation.linkType,
    linkUrl: automation.linkUrl,
    tapButtonTitle: automation.tapButtonTitle,
    linkButtonTitle: automation.linkButtonTitle,
    linkMessage: automation.linkMessage,
    publicReplyEnabled: automation.publicReplyEnabled,
    followupEnabled: automation.followupEnabled,
    followupDelayMinutes: String(automation.followupDelayMinutes),
    followupText: automation.followupText,
    startsAt: isoToInput(automation.schedule.startsAt),
    endsAt: isoToInput(automation.schedule.endsAt),
    dailyStart: automation.schedule.dailyStart ?? '',
    dailyEnd: automation.schedule.dailyEnd ?? '',
    outsideHours: automation.schedule.outsideHours,
    dryRun: automation.dryRun,
  };
}

/** Keywords as chips: adds what was typed, ignoring case when checking for one already there. */
export function addKeywords(keywords, typed) {
  const next = [...keywords];
  for (const word of splitList(typed)) {
    if (!next.some((existing) => existing.toLowerCase() === word.toLowerCase())) next.push(word);
  }
  return next;
}

export const byteLength = (text) => new TextEncoder().encode(String(text ?? '')).length;
const charLength = (text) => [...String(text ?? '')].length;
const VARIABLE = /\{[^{}\n]{1,40}\}/g;
const KNOWN_VARIABLES = new Set(['{first_name}', '{url}']);
export const unknownVariables = (text) => (String(text ?? '').match(VARIABLE) ?? []).filter((found) => !KNOWN_VARIABLES.has(found));

/** "1,200 / 1,000 bytes", as the editor shows it. */
export const bytesLabel = (text) => `${byteLength(text).toLocaleString('en-IN')} / ${LIMITS.textBytes.toLocaleString('en-IN')} bytes`;

/** Picking from the grid. A story and a reel can't share one automation, so a different kind starts the selection again and sets the trigger. */
export function toggleMedia(form, media) {
  const triggerType = media.type === 'story' ? 'story_reply' : 'comment';
  const kept = form.triggerType === triggerType ? form.media : [];
  const picked = kept.some((item) => item.id === media.id);
  return {
    triggerType,
    anyStory: false,
    media: picked ? kept.filter((item) => item.id !== media.id) : [...kept, toPick(media)],
    name: form.name || (picked ? '' : media.caption.trim().slice(0, 60)),
  };
}

/** Choosing a trigger from the list. Picks that can't start it go, so the server isn't asked to refuse them. */
export function changeTrigger(form, triggerType) {
  const fits = (item) => (triggerType === 'comment' ? item.type !== 'story' : triggerType === 'story_reply' && item.type === 'story');
  return { triggerType, anyStory: false, media: form.media.filter(fits) };
}

function nextLabel(variants) {
  return VARIANT_LABELS.find((label) => !variants.some((variant) => variant.label === label));
}

export function addVariant(variants) {
  const label = nextLabel(variants);
  return label ? [...variants, blankVariant(label)] : variants;
}

export function triggersFor(form) {
  const trigger = triggerOf(form.triggerType);
  if (!trigger.usesMedia) return form.otherTriggers;
  if (form.triggerType === 'story_reply' && form.anyStory) return [{ channel: 'instagram', targetType: 'any_story' }];
  return form.media.map((item) => ({ channel: item.channel, targetType: item.type, mediaId: item.id, permalink: item.permalink, thumbnailUrl: item.thumbnailUrl, caption: item.caption.slice(0, 500) }));
}

function variantErrors(variants) {
  for (const variant of variants) {
    const name = variants.length > 1 ? `Variant ${variant.label}: ` : '';
    if (!variant.body.trim()) return `${name}Write the message`;
    if (byteLength(variant.body) > LIMITS.textBytes) return `${name}Keep the message to ${LIMITS.textBytes.toLocaleString('en-IN')} bytes. Hindi letters count as 3 each.`;
    if (unknownVariables(variant.body).length) return `${name}${unknownVariables(variant.body)[0]} can’t be used. Use the first name and link buttons.`;
  }
  return null;
}

function checkSchedule(form, errors) {
  if (form.startsAt && form.endsAt && inputToIso(form.endsAt) <= inputToIso(form.startsAt)) errors.schedule = 'The end has to be after the start.';
  else if (Boolean(form.dailyStart) !== Boolean(form.dailyEnd)) errors.schedule = 'Set both the daily start and the daily end.';
  else if (form.dailyStart && form.dailyStart === form.dailyEnd) errors.schedule = 'The daily start and end can’t be the same.';
}

function checkButtons(form, errors) {
  const tooLong = (text) => charLength(text.trim()) > LIMITS.buttonTitleChars;
  const message = `Keep the button text to ${LIMITS.buttonTitleChars} characters.`;
  if (form.linkMode === 'two_tap' && tooLong(form.tapButtonTitle)) errors.tapButtonTitle = message;
  if (tooLong(form.linkButtonTitle)) errors.linkButtonTitle = message;
}

function checkFollowup(form, errors) {
  if (!form.followupEnabled) return;
  if (!form.followupText.trim()) errors.followupText = 'Write the follow-up message.';
  const delay = Number(form.followupDelayMinutes);
  if (!Number.isInteger(delay) || delay < LIMITS.followupMinMinutes || delay > LIMITS.followupMaxMinutes) {
    errors.followupDelayMinutes = `Use ${LIMITS.followupMinMinutes} to ${LIMITS.followupMaxMinutes} minutes.`;
  }
}

/** Whether matching applies at all, and what it comes to, given the trigger. */
function matching(form) {
  const { keywords: rule } = triggerOf(form.triggerType);
  if (rule === 'none') return { matchMode: 'any', keywords: [] };
  if (form.matchMode === 'any') return { matchMode: 'any', keywords: [] };
  return { matchMode: 'keywords', keywords: addKeywords(form.keywords, form.keywordDraft) };
}

export const publicReplyProblem = (form, replyCount) => (form.publicReplyEnabled && replyCount !== null && replyCount < LIMITS.publicReplyMinVariants ? `Add at least ${LIMITS.publicReplyMinVariants} replies` : '');

/**
 * The form as the API wants it, or `errors` by field. Everything found is reported at once. `replyCount` is how many public
 * replies the brand kit has, or null for someone who can't read it: the server checks it for them.
 */
export function formToAutomation(form, { replyCount = null } = {}) {
  const errors = {};
  const trigger = triggerOf(form.triggerType);
  const name = form.name.trim();
  if (!name) errors.name = 'Give this automation a name';

  const { matchMode, keywords } = matching(form);
  if (trigger.keywords === 'required' && matchMode === 'keywords' && !keywords.length) errors.keywords = 'Add at least one keyword';
  if (keywords.length > LIMITS.keywordsMax) errors.keywords = `Use ${LIMITS.keywordsMax} keywords or fewer`;
  if (form.triggerType === 'comment' && matchMode === 'any' && !form.anyModeAcknowledged) errors.anyModeAcknowledged = 'Confirm you understand to use this.';

  const variantProblem = variantErrors(form.variants);
  if (variantProblem) errors.variants = variantProblem;
  checkButtons(form, errors);
  checkFollowup(form, errors);
  checkSchedule(form, errors);
  const replies = trigger.value === 'comment' ? publicReplyProblem(form, replyCount) : '';
  if (replies) errors.publicReplyEnabled = replies;
  if (Object.keys(errors).length) return { errors };

  return {
    body: {
      name,
      triggerType: form.triggerType,
      matchMode,
      anyModeAcknowledged: form.anyModeAcknowledged,
      keywords,
      includeReactions: form.includeReactions,
      priority: Number(form.priority) || 0,
      linkMode: form.linkMode,
      linkType: form.linkType,
      linkUrl: form.linkUrl.trim(),
      tapButtonTitle: form.tapButtonTitle.trim(),
      linkButtonTitle: form.linkButtonTitle.trim(),
      publicReplyEnabled: trigger.value === 'comment' && form.publicReplyEnabled,
      followupEnabled: form.followupEnabled,
      followupDelayMinutes: Number(form.followupDelayMinutes),
      followupText: form.followupText.trim(),
      linkMessage: form.linkMessage.trim(),
      schedule: {
        startsAt: inputToIso(form.startsAt),
        endsAt: inputToIso(form.endsAt),
        dailyStart: form.dailyStart || null,
        dailyEnd: form.dailyEnd || null,
        outsideHours: form.outsideHours,
      },
      dryRun: form.dryRun,
      triggers: triggersFor(form),
      variants: form.variants.map((variant) => ({ ...variant, body: variant.body.trim(), buttonTitle: variant.buttonTitle.trim(), fallbackText: variant.fallbackText.trim() })),
    },
  };
}

/** The Reach Guard warnings, as the owner types (PRD 6.8). The same three the server returns after saving, plus the two-tap one. */
export function draftWarnings(form) {
  const warnings = [];
  const trigger = triggerOf(form.triggerType);
  if (form.triggerType === 'comment' && form.matchMode === 'any') warnings.push({ code: 'any_mode', message: 'Every comment will get a DM. Replying to everything can look like spam and reduce your reach.' });
  if (form.variants.length < 2 && form.variants[0].body.trim()) warnings.push({ code: 'single_variant', message: 'Add a second version of the message so people don’t all get the same words.' });
  if (trigger.keywords !== 'none' && form.matchMode === 'keywords') {
    const short = form.keywords.find((word) => /[\p{L}\p{N}]/u.test(word) && charLength(word.trim()) < 3);
    if (short) warnings.push({ code: 'short_keyword', message: `"${short}" is very short and may match comments you didn’t mean.` });
  }
  if (form.triggerType === 'comment' && form.linkMode === 'two_tap' && form.variants.some((variant) => variant.body.includes('{url}'))) {
    warnings.push({ code: 'two_tap_url', message: 'With two taps the first message has no link, so the link in it stays empty.' });
  }
  return warnings;
}

/** The list above the launch buttons. A guide for the seller: the server makes the real decision. */
export function launchChecks(form, { replyCount = null } = {}) {
  const trigger = triggerOf(form.triggerType);
  const bodies = form.variants.map((variant) => variant.body);
  const checks = [];
  if (trigger.usesMedia) checks.push({ label: 'Picked where it runs', ok: form.media.length > 0 || form.anyStory });
  if (trigger.keywords === 'required') checks.push({ label: 'Keyword added', ok: form.matchMode === 'any' || form.keywords.length > 0 || form.keywordDraft.trim() !== '' });
  checks.push({ label: 'Message written', ok: bodies.every((body) => body.trim() !== '') });
  checks.push({ label: 'Message within the limit', ok: bodies.every((body) => byteLength(body) <= LIMITS.textBytes) });
  checks.push({ label: 'Only allowed variables', ok: bodies.every((body) => unknownVariables(body).length === 0) });
  if (trigger.needsLink) checks.push({ label: 'Link added', ok: form.linkUrl.trim() !== '' });
  checks.push({ label: 'Button text within the limit', ok: charLength(form.linkButtonTitle.trim()) <= LIMITS.buttonTitleChars && charLength(form.tapButtonTitle.trim()) <= LIMITS.buttonTitleChars });
  if (trigger.value === 'comment' && form.publicReplyEnabled) checks.push({ label: 'Enough public replies', ok: !publicReplyProblem(form, replyCount) });
  return checks;
}

const STATE_MOVES = Object.freeze({
  draft: ['test', 'live', 'archived'],
  test: ['live', 'draft', 'archived'],
  live: ['paused', 'archived'],
  paused: ['live', 'test', 'draft', 'archived'],
  archived: ['draft'],
});
export const STATE_ACTIONS = Object.freeze({ test: 'Start testing', live: 'Go live', paused: 'Pause', draft: 'Back to draft', archived: 'Archive' });
export const stateMoves = (state) => STATE_MOVES[state] ?? [];
export const STATE_DONE = Object.freeze({ test: 'Test mode is on. Only your testers get real DMs.', live: 'It’s live.', paused: 'Paused.', draft: 'Back to draft.', archived: 'Archived.' });

/** What a tester sees in the preview when the server can't be asked. Never shows a variable's name. */
export function fillLocally(text, { firstName = 'Asha', url = '' } = {}) {
  return String(text ?? '').replaceAll('{first_name}', firstName).replaceAll('{url}', url).replace(/[^\S\n]+([,.!?:;])/g, '$1').trim();
}
