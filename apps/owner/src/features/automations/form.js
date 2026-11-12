/**
 * Pure: the builder's form, its checks and the shape the API wants (the console's automations/form.js), with every
 * message a string key ({ key, values }) so the app says it in English and Hindi. No React, so the server's tests load
 * it too, and a test keeps LIMITS equal to COMPLIANCE_LIMITS. The server makes the real decision on every rule.
 */
import { addKeywords } from '../reels/form.js';

export { addKeywords };

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
export const STATE_TONES = Object.freeze({ draft: 'neutral', test: 'primary', live: 'good', paused: 'warn', archived: 'neutral' });
export const STATES = Object.freeze(Object.keys(STATE_TONES));

/** `entitlement` is the plan feature a trigger needs, so the builder can leave out what the plan lacks. */
export const TRIGGERS = Object.freeze([
  { value: 'comment', usesMedia: true, keywords: 'required', needsLink: true, entitlement: 'triggers.comment' },
  { value: 'story_reply', usesMedia: true, keywords: 'optional', needsLink: true, entitlement: 'triggers.story_dm' },
  { value: 'story_mention', usesMedia: false, keywords: 'none', needsLink: true, entitlement: 'triggers.story_dm' },
  { value: 'dm_keyword', usesMedia: false, keywords: 'required', needsLink: false, entitlement: null },
  { value: 'dm_welcome', usesMedia: false, keywords: 'none', needsLink: false, entitlement: null },
]);
export const triggerOf = (type) => TRIGGERS.find((trigger) => trigger.value === type) ?? TRIGGERS[0];

/** The triggers this plan has: all of them while the plan's entitlements are not known (the server refuses again). */
export const triggersFor = (entitlements) => TRIGGERS.filter((trigger) => !trigger.entitlement || !entitlements || entitlements[trigger.entitlement] !== false);

export const LINK_TYPES = Object.freeze(['seller_site', 'bhava_page', 'amazon', 'affiliate', 'whatsapp']);

/** Which tracking id a link type can carry (PRD 6.6). */
export const TRACKING = Object.freeze({ amazon: 'amazon_tag', affiliate: 'affiliate_sub_id' });

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

// ---- time: the schedule is in India time, the default for every business (PRD 6.8) ----

const IST = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
const WHEN = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "2026-11-14 09:30" as typed is a date and time in India time. */
export const isWhen = (text) => {
  const match = WHEN.exec(String(text ?? '').trim());
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
};
export const isTime = (text) => TIME.test(String(text ?? '').trim());

/** What was typed, read as India time, to an ISO instant; null for nothing. */
export function inputToIso(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const [, y, m, d, h, min] = WHEN.exec(text) ?? [];
  return y ? `${y}-${m}-${d}T${h}:${min}:00${IST_OFFSET}` : null;
}

/** An instant as the box shows it, in India time: "2026-11-14 09:30". */
export function isoToInput(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
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

/** UTF-8 bytes, the way Meta counts the 1,000 (a Hindi letter is 3). */
export function byteLength(text) {
  let bytes = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
const charLength = (text) => [...String(text ?? '')].length;
const VARIABLE = /\{[^{}\n]{1,40}\}/g;
const KNOWN_VARIABLES = new Set(['{first_name}', '{url}']);
export const unknownVariables = (text) => (String(text ?? '').match(VARIABLE) ?? []).filter((found) => !KNOWN_VARIABLES.has(found));

/** Picking from the grid. A story and a reel can't share one automation, so a different kind starts again and sets the trigger. */
export function toggleMedia(form, media) {
  const triggerType = media.type === 'story' ? 'story_reply' : 'comment';
  const kept = form.triggerType === triggerType ? form.media : [];
  const picked = kept.some((item) => item.id === media.id);
  return {
    triggerType,
    anyStory: false,
    media: picked ? kept.filter((item) => item.id !== media.id) : [...kept, toPick(media)],
    name: form.name || (picked ? '' : String(media.caption ?? '').trim().slice(0, 60)),
  };
}

/** Choosing a trigger. Picks that can't start it go, so the server isn't asked to refuse them. */
export function changeTrigger(form, triggerType) {
  const fits = (item) => (triggerType === 'comment' ? item.type !== 'story' : triggerType === 'story_reply' && item.type === 'story');
  return { triggerType, anyStory: false, media: form.media.filter(fits) };
}

export function addVariant(variants) {
  const label = VARIANT_LABELS.find((candidate) => !variants.some((variant) => variant.label === candidate));
  return label ? [...variants, blankVariant(label)] : variants;
}

export function triggerList(form) {
  const trigger = triggerOf(form.triggerType);
  if (!trigger.usesMedia) return form.otherTriggers;
  if (form.triggerType === 'story_reply' && form.anyStory) return [{ channel: 'instagram', targetType: 'any_story' }];
  return form.media.map((item) => ({ channel: item.channel, targetType: item.type, mediaId: item.id, permalink: item.permalink, thumbnailUrl: item.thumbnailUrl, caption: String(item.caption ?? '').slice(0, 500) }));
}

function variantError(variants) {
  for (const variant of variants) {
    const values = { label: variant.label };
    const named = variants.length > 1;
    if (!variant.body.trim()) return { key: named ? 'automations.error.writeVariant' : 'automations.error.write', values };
    if (byteLength(variant.body) > LIMITS.textBytes) return { key: named ? 'automations.error.tooLongVariant' : 'automations.error.tooLong', values: { ...values, max: LIMITS.textBytes.toLocaleString('en-IN') } };
    const unknown = unknownVariables(variant.body);
    if (unknown.length) return { key: named ? 'automations.error.variableVariant' : 'automations.error.variable', values: { ...values, variable: unknown[0] } };
  }
  return null;
}

function checkSchedule(form, errors) {
  for (const field of ['startsAt', 'endsAt']) {
    if (form[field].trim() && !isWhen(form[field])) errors[field] = { key: 'automations.error.when' };
  }
  for (const field of ['dailyStart', 'dailyEnd']) {
    if (form[field].trim() && !isTime(form[field])) errors[field] = { key: 'automations.error.time' };
  }
  if (errors.startsAt || errors.endsAt || errors.dailyStart || errors.dailyEnd) return;
  if (form.startsAt && form.endsAt && inputToIso(form.endsAt) <= inputToIso(form.startsAt)) errors.schedule = { key: 'automations.error.endAfterStart' };
  else if (Boolean(form.dailyStart.trim()) !== Boolean(form.dailyEnd.trim())) errors.schedule = { key: 'automations.error.bothTimes' };
  else if (form.dailyStart && form.dailyStart.trim() === form.dailyEnd.trim()) errors.schedule = { key: 'automations.error.sameTimes' };
}

function checkButtons(form, errors) {
  const tooLong = (text) => charLength(text.trim()) > LIMITS.buttonTitleChars;
  const error = { key: 'automations.error.button', values: { max: LIMITS.buttonTitleChars } };
  if (form.linkMode === 'two_tap' && tooLong(form.tapButtonTitle)) errors.tapButtonTitle = error;
  if (tooLong(form.linkButtonTitle)) errors.linkButtonTitle = error;
}

function checkFollowup(form, errors) {
  if (!form.followupEnabled) return;
  if (!form.followupText.trim()) errors.followupText = { key: 'automations.error.followupText' };
  const text = String(form.followupDelayMinutes).trim();
  const delay = Number(text);
  if (!/^\d+$/.test(text) || delay < LIMITS.followupMinMinutes || delay > LIMITS.followupMaxMinutes) {
    errors.followupDelayMinutes = { key: 'automations.error.followupDelay', values: { min: LIMITS.followupMinMinutes, max: LIMITS.followupMaxMinutes } };
  }
}

/** Whether matching applies at all, and what it comes to, given the trigger. */
function matching(form) {
  const { keywords: rule } = triggerOf(form.triggerType);
  if (rule === 'none' || form.matchMode === 'any') return { matchMode: 'any', keywords: [] };
  return { matchMode: 'keywords', keywords: addKeywords(form.keywords, form.keywordDraft) };
}

/** `replyCount` is how many public replies the brand kit has, or null for someone who can't read it: the server checks it for them. */
export const publicReplyProblem = (form, replyCount) => (form.publicReplyEnabled && replyCount !== null && replyCount < LIMITS.publicReplyMinVariants
  ? { key: 'automations.error.replies', values: { min: LIMITS.publicReplyMinVariants } }
  : null);

/** The form as the API wants it, or `errors` by field. Everything found is reported at once. */
export function formToAutomation(form, { replyCount = null } = {}) {
  const errors = {};
  const trigger = triggerOf(form.triggerType);
  const name = form.name.trim();
  if (!name) errors.name = { key: 'automations.error.name' };

  const { matchMode, keywords } = matching(form);
  if (trigger.keywords === 'required' && matchMode === 'keywords' && !keywords.length) errors.keywords = { key: 'automations.error.keyword' };
  if (keywords.length > LIMITS.keywordsMax) errors.keywords = { key: 'automations.error.keywords', values: { max: LIMITS.keywordsMax } };
  if (form.triggerType === 'comment' && matchMode === 'any' && !form.anyModeAcknowledged) errors.anyModeAcknowledged = { key: 'automations.error.acknowledge' };

  const variantProblem = variantError(form.variants);
  if (variantProblem) errors.variants = variantProblem;
  checkButtons(form, errors);
  checkFollowup(form, errors);
  checkSchedule(form, errors);
  const replies = trigger.value === 'comment' ? publicReplyProblem(form, replyCount) : null;
  if (replies) errors.publicReplyEnabled = replies;
  const priority = String(form.priority).trim();
  if (trigger.value === 'dm_keyword' && priority && !(/^\d+$/.test(priority) && Number(priority) <= 1000)) errors.priority = { key: 'automations.error.priority' };
  if (Object.keys(errors).length) return { errors };

  return {
    body: {
      name,
      triggerType: form.triggerType,
      matchMode,
      anyModeAcknowledged: form.anyModeAcknowledged,
      keywords,
      includeReactions: form.includeReactions,
      priority: Number(priority) || 0,
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
        dailyStart: form.dailyStart.trim() || null,
        dailyEnd: form.dailyEnd.trim() || null,
        outsideHours: form.outsideHours,
      },
      dryRun: form.dryRun,
      triggers: triggerList(form),
      variants: form.variants.map((variant) => ({ ...variant, body: variant.body.trim(), buttonTitle: variant.buttonTitle.trim(), fallbackText: variant.fallbackText.trim() })),
    },
  };
}

/** The Reach Guard warnings, as the owner types (PRD 6.8): the three the server returns after saving, and the two-tap one. */
export function draftWarnings(form) {
  const warnings = [];
  const trigger = triggerOf(form.triggerType);
  if (form.triggerType === 'comment' && form.matchMode === 'any') warnings.push({ code: 'any_mode', key: 'automations.warning.any_mode' });
  if (form.variants.length < 2 && form.variants[0]?.body.trim()) warnings.push({ code: 'single_variant', key: 'automations.warning.single_variant' });
  if (trigger.keywords !== 'none' && form.matchMode === 'keywords') {
    const short = form.keywords.find((word) => /[\p{L}\p{N}]/u.test(word) && charLength(word.trim()) < 3);
    if (short) warnings.push({ code: 'short_keyword', key: 'automations.warning.short_keyword', values: { word: short } });
  }
  if (form.triggerType === 'comment' && form.linkMode === 'two_tap' && form.variants.some((variant) => variant.body.includes('{url}'))) {
    warnings.push({ code: 'two_tap_url', key: 'automations.warning.two_tap_url' });
  }
  return warnings;
}

/** The list above the launch buttons, as string keys. A guide for the seller: the server makes the real decision. */
export function launchChecks(form, { replyCount = null } = {}) {
  const trigger = triggerOf(form.triggerType);
  const bodies = form.variants.map((variant) => variant.body);
  const checks = [];
  if (trigger.usesMedia) checks.push({ key: 'automations.check.media', ok: form.media.length > 0 || form.anyStory });
  if (trigger.keywords === 'required') checks.push({ key: 'automations.check.keyword', ok: form.matchMode === 'any' || form.keywords.length > 0 || form.keywordDraft.trim() !== '' });
  checks.push({ key: 'automations.check.message', ok: bodies.every((body) => body.trim() !== '') });
  checks.push({ key: 'automations.check.limit', ok: bodies.every((body) => byteLength(body) <= LIMITS.textBytes) });
  checks.push({ key: 'automations.check.variables', ok: bodies.every((body) => unknownVariables(body).length === 0) });
  if (trigger.needsLink) checks.push({ key: 'automations.check.link', ok: form.linkUrl.trim() !== '' });
  checks.push({ key: 'automations.check.buttons', ok: charLength(form.linkButtonTitle.trim()) <= LIMITS.buttonTitleChars && charLength(form.tapButtonTitle.trim()) <= LIMITS.buttonTitleChars });
  if (trigger.value === 'comment' && form.publicReplyEnabled) checks.push({ key: 'automations.check.replies', ok: !publicReplyProblem(form, replyCount) });
  return checks;
}

const STATE_MOVES = Object.freeze({
  draft: ['test', 'live', 'archived'],
  test: ['live', 'draft', 'archived'],
  live: ['paused', 'archived'],
  paused: ['live', 'test', 'draft', 'archived'],
  archived: ['draft'],
});
export const stateMoves = (state) => STATE_MOVES[state] ?? [];
/** Test and live send to someone, so moving there saves the form first. */
export const GOES_OUT = Object.freeze(['test', 'live']);

/** What a tester sees in the preview when the server can't be asked. Never shows a variable's name. */
export function fillLocally(text, { firstName = 'Asha', url = '' } = {}) {
  return String(text ?? '').replaceAll('{first_name}', firstName).replaceAll('{url}', url).replace(/[^\S\n]+([,.!?:;])/g, '$1').trim();
}

export const isFullLink = (text) => /^https?:\/\/\S+$/i.test(String(text ?? '').trim());

/**
 * The per-reel ids to save beside the automation, as calls: [{ op: 'create' | 'update' | 'remove', ... }]. Only with
 * exactly one post picked. `rows` is what measurementIds.list has for that post.
 */
export function trackingChanges(form, rows) {
  if (form.media.length !== 1) return [];
  const mediaId = form.media[0].id;
  const wanted = [[TRACKING[form.linkType], form.trackingId], ['discount_code', form.discountCode]].filter(([kind]) => kind);
  const changes = [];
  for (const [kind, typed] of wanted) {
    const value = String(typed ?? '').trim();
    const row = rows.find((candidate) => candidate.kind === kind);
    if (value && row && row.value !== value) changes.push({ op: 'update', id: row.id, value });
    else if (value && !row) changes.push({ op: 'create', mediaId, kind, value });
    else if (!value && row) changes.push({ op: 'remove', id: row.id });
  }
  return changes;
}

/** A field error from the server (its `fields`), as text under the form's own field. */
export function serverFieldErrors(error) {
  const out = {};
  for (const [field, message] of Object.entries(error?.fields ?? {})) {
    if (typeof message === 'string' && message.trim()) out[field.split('.')[0]] = { text: message.trim() };
  }
  return out;
}
