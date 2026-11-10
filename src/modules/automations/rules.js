import { ApiError } from '../../contracts/api/index.js';
import { COMPLIANCE_LIMITS as L } from '../../contracts/compliance.js';
import { checkContent } from '../compliance/content.js';
import { linkProblem } from '../links/rules.js';
import { hasWords } from './match.js';
import { render, unknownVariables } from './message.js';

/** What the builder enforces when an automation is saved or launched (PRD 6.1 to 6.5, 6.8). */

const TARGETS_BY_TRIGGER = Object.freeze({
  comment: ['reel', 'post'],
  story_reply: ['story', 'any_story'],
  story_mention: ['dm'],
  dm_keyword: ['dm'],
  dm_welcome: ['dm'],
});
const NEEDS_KEYWORDS = new Set(['comment', 'dm_keyword']);
const NEEDS_LINK = new Set(['comment', 'story_reply', 'story_mention']);
const NEEDS_TARGET = new Set(['comment', 'story_reply']);
const PAID_TRIGGERS = new Set(['story_reply', 'story_mention', 'dm_keyword', 'dm_welcome']);
const SHORT_KEYWORD_CHARS = 3;

const refuse = (message, field, reason) => new ApiError('validation_failed', message, { fields: { [field]: message }, reason });

/**
 * Every rule a piece of text breaks, as [{ reason, message, field }]. checkContent is compliance's; the two checks here are
 * about how this module fills templates in. `template` is what the owner typed and `text` what is being checked.
 */
export function contentProblems({ template, text = template, buttonTitle, quickReplies, filled = false }) {
  const found = [];
  if (unknownVariables(template).length) found.push({ reason: 'content.bad_variable', message: 'Only {first_name} and {url} can be used in a message.', field: 'text' });
  else if (!render(template, { firstName: '', url: 'x' })) found.push({ reason: 'content.bad_variable', message: 'The message has to read correctly without the name. Add some words.', field: 'text' });
  const seen = new Set(found.map((p) => p.reason));
  for (const problem of checkContent({ text, buttonTitle, quickReplies, filled })) {
    if (!seen.has(problem.reason)) found.push(problem);
    seen.add(problem.reason);
  }
  return found;
}

function assertContent(field, parts) {
  const [problem] = contentProblems(parts);
  if (problem) throw refuse(problem.message, problem.field === 'buttonTitle' && field.includes('.') ? field.replace(/\.\w+$/, '.buttonTitle') : field, problem.reason);
}

function checkMessages(input) {
  input.variants.forEach((variant, index) => {
    assertContent(`variants.${index}.body`, { template: variant.body, buttonTitle: variant.buttonTitle || undefined, quickReplies: variant.quickReplies });
    if (variant.fallbackText) assertContent(`variants.${index}.fallbackText`, { template: variant.fallbackText });
  });
  if (new Set(input.variants.map((v) => v.label)).size !== input.variants.length) throw refuse('Each version needs its own letter.', 'variants', undefined);
  if (input.linkMessage) assertContent('linkMessage', { template: input.linkMessage, buttonTitle: input.linkButtonTitle });
  if (input.followupEnabled && !input.followupText) throw refuse('Write the follow-up message.', 'followupText', undefined);
  if (input.followupText) assertContent('followupText', { template: input.followupText });
  for (const field of ['tapButtonTitle', 'linkButtonTitle']) {
    if (input[field]) assertContent(field, { template: 'x', buttonTitle: input[field] });
  }
}

function checkMatching(input) {
  if (input.matchMode === 'any') {
    if (input.triggerType === 'comment' && !input.anyModeAcknowledged) {
      throw refuse('Replying to every comment can look like spam and reduce your reach. Confirm you understand to use this.', 'anyModeAcknowledged', 'no_keyword');
    }
    return;
  }
  if (NEEDS_KEYWORDS.has(input.triggerType) && !input.keywords.length) throw refuse('Add at least one keyword', 'keywords', 'no_keyword');
}

function checkTriggers(input, config) {
  const allowed = TARGETS_BY_TRIGGER[input.triggerType];
  input.triggers.forEach((trigger, index) => {
    if (!allowed.includes(trigger.targetType)) throw refuse('That kind of post can’t start this automation.', `triggers.${index}.targetType`, undefined);
    if (['reel', 'post', 'story'].includes(trigger.targetType) && !trigger.mediaId) throw refuse('Pick the reel, post or story.', `triggers.${index}.mediaId`, undefined);
    if (trigger.channel === 'facebook' && !config.facebookPages) throw refuse('Facebook isn’t available yet.', `triggers.${index}.channel`, undefined);
  });
  const media = input.triggers.filter((t) => t.mediaId).map((t) => `${t.channel}:${t.mediaId}`);
  if (new Set(media).size !== media.length) throw refuse('That reel, post or story is listed twice.', 'triggers', undefined);
}

function checkSchedule({ startsAt, endsAt, dailyStart, dailyEnd }) {
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) throw refuse('The end has to be after the start.', 'schedule.endsAt', undefined);
  if (Boolean(dailyStart) !== Boolean(dailyEnd)) throw refuse('Set both the daily start and the daily end.', dailyStart ? 'schedule.dailyEnd' : 'schedule.dailyStart', undefined);
  if (dailyStart && dailyStart === dailyEnd) throw refuse('The daily start and end can’t be the same.', 'schedule.dailyEnd', undefined);
}

async function checkPlan(input, { repos }) {
  if (PAID_TRIGGERS.has(input.triggerType) && !(await repos.entitlements.can('triggers.story_dm'))) {
    throw refuse('Story and DM automations need a higher plan.', 'triggerType', undefined);
  }
  if (input.triggerType === 'comment' && !(await repos.entitlements.can('triggers.comment'))) throw refuse('Comment automations aren’t on your plan.', 'triggerType', undefined);
  if (input.linkMode === 'one_tap' && !(await repos.entitlements.can('links.one_tap'))) throw refuse('One tap needs a paid plan', 'linkMode', undefined);
}

async function checkLink(input, { repos }) {
  if (!input.linkUrl) return;
  const settings = await repos.settings.getAll();
  const reason = linkProblem(input.linkUrl, { whatsappNumber: settings.support_whatsapp, blockedHosts: await repos.automations.blockedHosts() });
  if (reason) throw refuse('That link can’t be used in a DM.', 'linkUrl', reason);
}

async function checkPublicReplies(input, { repos }) {
  if (input.publicReplyEnabled && (await repos.brandKit.get()).publicReplyVariants.length < L.publicReplyMinVariants) {
    throw refuse(`Add at least ${L.publicReplyMinVariants} replies`, 'publicReplyEnabled', undefined);
  }
}

/** Throws an ApiError for the first rule `input` breaks. `input` is the whole automation as it would be after this save. */
export async function checkSave(input, deps) {
  checkMatching(input);
  checkTriggers(input, deps.config);
  checkMessages(input);
  checkSchedule(input.schedule);
  await checkPlan(input, deps);
  await checkLink(input, deps);
  await checkPublicReplies(input, deps);
}

/** What going to Test or Live adds to the rules for saving. */
export async function checkLaunch(automation, deps) {
  await checkSave(automation, deps);
  if (NEEDS_TARGET.has(automation.triggerType) && !automation.triggers.length) throw refuse('Pick the reel, post or story this runs on.', 'triggers', undefined);
  if (NEEDS_LINK.has(automation.triggerType) && !automation.linkUrl) throw refuse('Add the link people will get.', 'linkUrl', undefined);
  if (automation.linkStatus === 'failed') throw refuse('The link failed its check. Fix it before going live.', 'linkUrl', 'link.check_failed');
}

/** A story mention isn't tied to one post, and a target with no media of its own has no media id. */
export function normalizeTriggers(triggerType, triggers) {
  return triggers.map((trigger) => {
    const targetType = triggerType === 'story_mention' ? 'dm' : trigger.targetType;
    return { ...trigger, targetType, mediaId: ['reel', 'post', 'story'].includes(targetType) ? trigger.mediaId : '' };
  });
}

/** What the builder shows without stopping the save (PRD 6.8). */
export function warningsFor(automation) {
  const warnings = [];
  if (automation.triggerType === 'comment' && automation.matchMode === 'any') {
    warnings.push({ code: 'any_mode', message: 'Every comment will get a DM. Replying to everything can look like spam and reduce your reach.' });
  }
  if (automation.variants.length < 2) warnings.push({ code: 'single_variant', message: 'Add a second version of the message so people don’t all get the same words.' });
  const short = automation.keywords.filter((k) => hasWords(k) && [...k.trim()].length < SHORT_KEYWORD_CHARS);
  if (short.length) warnings.push({ code: 'short_keyword', message: `"${short[0]}" is very short and may match comments you didn’t mean.` });
  if (automation.triggerType === 'comment' && automation.linkMode === 'two_tap' && automation.variants.some((v) => v.body.includes('{url}'))) {
    warnings.push({ code: 'two_tap_url', message: 'With two taps the first message has no link, so {url} stays empty there.' });
  }
  return warnings;
}
