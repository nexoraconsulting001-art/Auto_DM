import { z } from 'zod';

/**
 * The compliance engine's interface (PRD 4): the reason codes, Meta's limits as Bhava applies them, and the shape of
 * what goes into and comes out of compliance.send(). Plain data and zod only, so the console can use it too.
 */

/** The only reason-code enum (PRD 4.16). The compliance_reason_codes table holds the same list and a test keeps them equal. */
export const REASON_CODE_FAMILIES = Object.freeze({
  outcome: Object.freeze(['queued', 'held', 'sent', 'sent_fallback', 'unknown', 'failed', 'cancelled', 'expired', 'skipped', 'would_send']),
  intake: Object.freeze(['webhook.bad_signature', 'webhook.duplicate', 'webhook.malformed', 'tenant.unknown_entry', 'api.host_blocked']),
  trigger: Object.freeze(['unmapped', 'no_keyword', 'own_account', 'own_thread', 'unsupported_media', 'test_mode', 'automation.draft', 'outside_hours', 'too_short']),
  policy: Object.freeze(['optout', 'negative_intent', 'window.closed', 'expired.7d', 'expired.public_reply', 'followup.no_response', 'mention.no_window', 'tag.not_allowed', 'thread.handoff', 'thread.owner_replied', 'comment.deleted', 'comment.edited', 'recipient.unavailable']),
  cap: Object.freeze(['cap.per_comment', 'cap.per_media', 'cap.per_person_24h', 'cap.mention_7d', 'cap.followup', 'cap.welcome_once', 'cap.reply_per_message', 'cap.dm_replies_24h', 'cap.public_reply_media_h', 'cap.public_reply_tenant_h']),
  content: Object.freeze(['content.too_long', 'content.financial_request', 'content.button_title', 'content.bad_variable', 'content.bhava_promo']),
  link: Object.freeze(['link.scheme', 'link.shortener', 'link.not_allowlisted', 'link.redirect', 'link.blocked', 'link.check_failed']),
  rate: Object.freeze(['rate.throttled', 'rate.usage_header', 'rate.slow_mode', 'fallback.validation', 'send.unknown_outcome', 'send.error']),
  pause: Object.freeze(['paused.automation', 'paused.tenant', 'paused.global', 'paused.breaker', 'paused.reconnect', 'held.review', 'held.dm_limit', 'cancelled.owner', 'cancelled.optout']),
  token: Object.freeze(['token.refreshed', 'token.refresh_failed', 'token.rejected', 'token.deauthorized']),
  gate: Object.freeze(['gate.access_level', 'gate.scope_missing', 'gate.privacy_url', 'gate.deletion_callback', 'gate.passed']),
  data: Object.freeze(['deletion.requested', 'deletion.completed']),
  addon: Object.freeze(['ai.low_confidence', 'ai.ungrounded', 'ai.handoff', 'ai.provider_failed', 'wa.no_optin']),
});
export const OUTCOMES = REASON_CODE_FAMILIES.outcome;
export const REASON_CODES = Object.freeze(Object.values(REASON_CODE_FAMILIES).flat());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Meta's limits as Bhava applies them (PRD 4.3, 4.5, 4.7, 4.9, 4.10). Every rule reads these numbers. */
export const COMPLIANCE_LIMITS = Object.freeze({
  privateRepliesPerHour: 600,
  sendApiPerSecond: 20,
  conversationsPerSecond: 1,
  reducedBudgetMultiplier: 0.5,
  graphTimeoutMs: 10_000,
  leaseMs: 60_000,
  privateReplyExpiryMs: 7 * DAY - HOUR,
  privateReplyNoTimestampExpiryMs: 7 * DAY - HOUR - 36 * HOUR,
  messagingWindowMs: 23 * HOUR + 50 * MINUTE,
  followupMinDelayMs: 30 * MINUTE,
  switchCacheMs: 5_000,
  textBytes: 1000,
  buttonTextChars: 640,
  buttonsMax: 3,
  buttonTitleChars: 20,
  quickRepliesMax: 13,
  quickReplyTitleChars: 20,
  iceBreakersMax: 4,
  keywordsMax: 20,
  variantsMax: 3,
  capPerPerson24h: 3,
  capDmReplies24h: 10,
  publicReplyMinVariants: 5,
  publicReplyMaxVariants: 10,
  publicReplyMaxChars: 150,
  publicReplyMinDelayMs: 20_000,
  publicReplyMaxDelayMs: 90_000,
  publicReplyExpiryMs: HOUR,
  publicRepliesPerMediaHour: 20,
  publicRepliesPerTenantHour: 60,
  threadHandoffMs: 24 * HOUR,
  threadOwnerRepliedMs: 12 * HOUR,
  testerCodeMs: 15 * MINUTE,
});

/** What can put an account in slow mode (PRD 4.3). The owner's override applies only while reach_drop is the cause. */
export const SLOW_MODE_TRIGGERS = Object.freeze(['reach_drop', 'buc_80002', 'insights_denied']);

/** Calls to Meta that aren't messages, highest priority first (PRD 4.3). callAllowed() decides whether one may run. */
export const CALL_CLASSES = Object.freeze(['token_refresh', 'subscribed_apps', 'comment_timestamp', 'public_reply', 'story_insights', 'insights', 'media_list']);

/** The channels a seller connects through Meta login: the only ones an automation, a tester or a tracked link is made for. */
export const META_CHANNELS = Object.freeze(['instagram', 'facebook']);
export const MetaChannel = z.enum(META_CHANNELS);
/** Every channel the gate sends on. whatsapp (PRD 6.12) works once its module has registered it: src/modules/compliance/channels.js. */
export const CHANNELS = Object.freeze([...META_CHANNELS, 'whatsapp']);
export const Channel = z.enum(CHANNELS);
/** The column that names the account of a job or an inbox thread, per channel. Exactly one of the three is set on a row. */
export const ACCOUNT_COLUMNS = Object.freeze({ instagram: 'ig_user_id', facebook: 'fb_page_id', whatsapp: 'wa_phone_number_id' });
export const SEND_KINDS = Object.freeze(['private_reply', 'dm', 'public_reply']);
/** ai_reply (PRD 6.11) is the one automated reply to the inbound DM it answers, as faq is: the same key and the same cap. */
export const SEND_PURPOSES = Object.freeze(['trigger', 'link', 'followup', 'welcome', 'faq', 'optout_confirm', 'manual', 'test', 'ai_reply']);
/** What someone said yes to on WhatsApp (whatsapp_optins.purpose), and what a template is sent for. */
export const WHATSAPP_OPTIN_PURPOSES = Object.freeze(['marketing', 'order_updates']);

/** { url, title } opens a page, { payload, title } comes back as a postback (the two-tap flow, PRD 6.13). */
export const ComplianceButton = z.union([
  z.object({ url: z.string().min(1), title: z.string().min(1) }),
  z.object({ payload: z.string().min(1), title: z.string().min(1) }),
]);

export const ComplianceMessage = z.object({
  text: z.string().min(1),
  button: ComplianceButton.optional(),
  quickReplies: z.array(z.object({ title: z.string().min(1), payload: z.string().min(1) })).optional(),
  /**
   * WhatsApp only: a message the business starts, as one of its approved templates. `text` is still the body as the person
   * will read it, for the content and link checks. It goes only to someone who opted in to `purpose` (wa.no_optin), and
   * needs no open window. Without `template` a WhatsApp message is free-form and needs the window (window.closed).
   */
  template: z.object({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/),
    language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('en'),
    params: z.array(z.string()).max(20).default([]),
    purpose: z.enum(WHATSAPP_OPTIN_PURPOSES).default('marketing'),
  }).optional(),
});

/**
 * One thing to send. `accountId` is the ig_user_id, Page id or WhatsApp phone number id it goes out from (on WhatsApp recipientId is the person's wa_id). commentId is required for a private or
 * public reply, recipientId (the IGSID or PSID) for a dm. personId is whose hash goes in the log; it is the same as
 * recipientId on a dm and the commenter on a reply. `expiresAt` is when it stops being allowed, whatever the reason it waited.
 */
export const ComplianceAction = z.object({
  kind: z.enum(SEND_KINDS),
  purpose: z.enum(SEND_PURPOSES).default('trigger'),
  channel: Channel.default('instagram'),
  accountId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
  expiresAt: z.date(),
  message: ComplianceMessage,
  commentId: z.string().min(1).optional(),
  recipientId: z.string().min(1).optional(),
  personId: z.string().min(1).optional(),
  automationId: z.number().int().positive().optional(),
  variantId: z.number().int().positive().optional(),
  mediaId: z.string().min(1).optional(),
  isTest: z.boolean().default(false),
}).superRefine((action, issues) => {
  if (action.kind !== 'dm' && !action.commentId) issues.addIssue({ code: 'custom', path: ['commentId'], message: 'A reply needs the comment it answers' });
  if (action.kind === 'dm' && !action.recipientId) issues.addIssue({ code: 'custom', path: ['recipientId'], message: 'A DM needs a recipient' });
  if (action.channel === 'whatsapp' && action.kind !== 'dm') issues.addIssue({ code: 'custom', path: ['kind'], message: 'WhatsApp has messages only' });
  if (action.channel !== 'whatsapp' && action.message.template) issues.addIssue({ code: 'custom', path: ['message', 'template'], message: 'Only WhatsApp has templates' });
});

/**
 * What came of it. `outcome` is one of OUTCOMES and `reason` a reason code or ''. A failure Meta answered with is
 * reported here and is not thrown; `error` is the MetaApiError. compliance.send() throws only on an invalid action or
 * outside withTenant().
 */
export const SendResultShape = z.object({
  outcome: z.enum(OUTCOMES),
  reason: z.union([z.enum(REASON_CODES), z.literal('')]),
  jobId: z.number().int().positive().nullable(),
  messageId: z.string().nullable(),
  status: z.number().int().nullable(),
  metaCode: z.number().int().nullable(),
  metaSubcode: z.number().int().nullable(),
});
