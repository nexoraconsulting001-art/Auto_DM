import crypto from 'node:crypto';
import { fillTemplate } from '../compliance/content.js';

const VARIABLE = /\{[^{}\n]{1,40}\}/g;
const MAX_KEY_PART = 150;

/**
 * The idempotency key of the one automated reply to an inbound DM (PRD 4.7, 6.4): a keyword rule's answer, an ice
 * breaker's and an AI reply (6.11) all use it, with { inReplyTo: mid }, so whichever comes second is refused. Message
 * ids run long and a key stops at 200 characters, so a long one is hashed.
 */
export const dmReplyKey = (mid) => `dm_reply:${String(mid).length > MAX_KEY_PART ? crypto.createHash('sha256').update(String(mid)).digest('hex').slice(0, 40) : String(mid)}`;
const KNOWN_VARIABLES = new Set(['{first_name}', '{url}']);

/** Variables a template uses that don't exist (PRD 4.10). */
export const unknownVariables = (template) => (String(template).match(VARIABLE) ?? []).filter((v) => !KNOWN_VARIABLES.has(v));

/** What an empty {first_name} or {url} leaves behind: "Hi , here it is" reads "Hi, here it is". */
const tidy = (text) => text.replace(/[^\S\n]+([,.!?:;])/g, '$1').replace(/[^\S\n]{2,}/g, ' ').replace(/^[\s,;:.!?-]+/, '').trim();

/** The template with its variables filled. It still reads correctly when a value is missing (PRD 6.5, A-28). */
export function render(template, { firstName = '', url = '' } = {}) {
  const filled = fillTemplate(template, { firstName, url });
  const leftEmpty = (!firstName && template.includes('{first_name}')) || (!url && template.includes('{url}'));
  return leftEmpty ? tidy(filled) : filled;
}

/**
 * Which version this person gets: the winner once there is one, otherwise a share by weight. The share comes from a hash
 * of the automation and the person, so one person always gets the same version of one automation (PRD 6.5).
 */
export function chooseVariant({ variants, winnerVariantId }, key) {
  const winner = winnerVariantId && variants.find((v) => v.id === winnerVariantId);
  if (winner) return winner;
  const weighted = variants.filter((v) => v.weight > 0);
  const pool = [...(weighted.length ? weighted : variants)].sort((a, b) => a.label.localeCompare(b.label));
  if (!pool.length) return null;
  const weightOf = (v) => (weighted.length ? v.weight : 1);
  let point = parseInt(crypto.createHash('sha256').update(key).digest('hex').slice(0, 12), 16) % pool.reduce((sum, v) => sum + weightOf(v), 0);
  for (const variant of pool) {
    point -= weightOf(variant);
    if (point < 0) return variant;
  }
  return pool[0];
}

/** What a two-tap button sends back (PRD 6.13). The links track parses it with parseTwoTapPayload. It is never shown to anyone. */
export const twoTapPayload = ({ automationId, variantId, mediaId, commentId }) => `two_tap:${automationId}:${variantId}:${mediaId}:${commentId}`;

export function parseTwoTapPayload(payload) {
  const match = /^two_tap:(\d{1,10}):(\d{1,10}):([^:]{1,80}):([^:]{1,80})$/.exec(String(payload));
  return match ? { automationId: Number(match[1]), variantId: Number(match[2]), mediaId: match[3], commentId: match[4] } : null;
}

/** An ice breaker's button (PRD 6.4). */
export const faqPayload = (position) => `faq:${position}`;
export const parseFaqPayload = (payload) => {
  const match = /^faq:([1-4])$/.exec(String(payload));
  return match ? Number(match[1]) : null;
};

/**
 * The first message of an automation, for compliance.
 *   mode 'two_tap'  a postback button and no address anywhere in the message (PRD 6.13)
 *   mode 'direct'   a button that opens the direct link (PRD 6.6)
 * No Bhava text is ever added here, on any plan (PRD 6.5). The seller's "Automated reply" note is added by the gate, so it counts toward the byte limit.
 */
export function firstMessage({ automation, variant, mode, firstName, finalUrl, payload }) {
  const twoTap = mode === 'two_tap' && Boolean(finalUrl);
  const message = { text: render(variant.body, { firstName, url: twoTap ? '' : finalUrl }) };
  if (twoTap) message.button = { payload, title: variant.buttonTitle || automation.tapButtonTitle };
  else if (finalUrl) message.button = { url: finalUrl, title: variant.buttonTitle || automation.linkButtonTitle };
  if (variant.quickReplies?.length) message.quickReplies = variant.quickReplies;
  return message;
}

/** A plain automated message: a follow-up or a question's answer. */
export const plainMessage = ({ template, firstName = '', finalUrl = '' }) => ({ text: render(template, { firstName, url: finalUrl }) });
