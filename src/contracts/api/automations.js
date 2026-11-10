import { z } from 'zod';
import { COMPLIANCE_LIMITS, Channel } from '../compliance.js';
import { MANAGERS, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Timestamp, page, required, text } from './common.js';

const access = staffWith('automations');

export const AUTOMATION_STATES = Object.freeze(['draft', 'test', 'live', 'paused', 'archived']);
export const TRIGGER_TYPES = Object.freeze(['comment', 'story_reply', 'story_mention', 'dm_keyword', 'dm_welcome']);
export const LINK_TYPES = Object.freeze(['seller_site', 'bhava_page', 'amazon', 'affiliate', 'whatsapp']);
export const VARIANT_LABELS = Object.freeze(['A', 'B', 'C']);

const VARIANT_BODY_MAX = 4000; // A bound on input. The real limits are in bytes and checked when saving (PRD 4.10).
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00');
const When = z.iso.datetime({ offset: true });

/** Something the owner should see, which doesn't stop the save (PRD 6.6, 6.8). */
export const SaveWarning = z.object({ code: z.string(), message: z.string() });

export const TriggerInput = z.object({
  channel: Channel.default('instagram'),
  targetType: z.enum(['reel', 'post', 'story', 'any_story', 'dm']),
  mediaId: text(80).default(''),
  permalink: text(1000).default(''),
  thumbnailUrl: text(2000).default(''),
  caption: text(500).default(''),
});
export const Trigger = z.object({ id: Id, channel: Channel, targetType: z.string(), mediaId: z.string(), permalink: z.string(), thumbnailUrl: z.string(), caption: z.string() });

export const QuickReplyInput = z.object({ title: required(COMPLIANCE_LIMITS.quickReplyTitleChars), payload: required(200) });

export const VariantInput = z.object({
  label: z.enum(VARIANT_LABELS),
  body: required(VARIANT_BODY_MAX, 'Write the message'),
  buttonTitle: text(COMPLIANCE_LIMITS.buttonTitleChars * 4).default(''),
  fallbackText: text(VARIANT_BODY_MAX).default(''),
  weight: z.number().int().min(0).max(100).default(1),
  quickReplies: z.array(QuickReplyInput).max(COMPLIANCE_LIMITS.quickRepliesMax).default([]),
});
export const Variant = z.object({ id: Id, label: z.enum(VARIANT_LABELS), body: z.string(), buttonTitle: z.string(), fallbackText: z.string(), weight: Count, quickReplies: z.array(z.object({ title: z.string(), payload: z.string() })) });

export const Schedule = z.object({
  startsAt: When.nullable().default(null),
  endsAt: When.nullable().default(null),
  dailyStart: Time.nullable().default(null),
  dailyEnd: Time.nullable().default(null),
  outsideHours: z.enum(['hold', 'skip']).default('hold'),
});
export const ScheduleOut = z.object({ startsAt: Timestamp.nullable(), endsAt: Timestamp.nullable(), dailyStart: z.string().nullable(), dailyEnd: z.string().nullable(), outsideHours: z.enum(['hold', 'skip']) });

/**
 * The builder's one screen (PRD 6.8). The shape is checked here. The rules that depend on other fields or the plan
 * ("Add at least one keyword", one tap needs a paid plan, the content and link checks) are the handler's, and a broken
 * rule answers validation_failed with its reason code in `reason`.
 */
export const AutomationInput = z.object({
  name: required(120, 'Give this automation a name'),
  triggerType: z.enum(TRIGGER_TYPES),
  matchMode: z.enum(['keywords', 'any']).default('keywords'),
  anyModeAcknowledged: z.boolean().default(false),
  keywords: z.array(required(60)).max(COMPLIANCE_LIMITS.keywordsMax, `Use ${COMPLIANCE_LIMITS.keywordsMax} keywords or fewer`).default([]),
  includeReactions: z.boolean().default(false),
  priority: z.number().int().min(0).max(1000).default(0),
  linkMode: z.enum(['one_tap', 'two_tap']).default('two_tap'),
  linkType: z.enum(LINK_TYPES).default('seller_site'),
  linkUrl: text(2000).default(''),
  tapButtonTitle: text(COMPLIANCE_LIMITS.buttonTitleChars * 4).default('Send me the link'),
  linkButtonTitle: text(COMPLIANCE_LIMITS.buttonTitleChars * 4).default('Open the link'),
  publicReplyEnabled: z.boolean().default(false),
  followupEnabled: z.boolean().default(false),
  followupDelayMinutes: z.number().int().min(30).max(1430).default(30),
  followupText: text(VARIANT_BODY_MAX).default(''),
  linkMessage: text(VARIANT_BODY_MAX).default(''),
  schedule: Schedule.default({ startsAt: null, endsAt: null, dailyStart: null, dailyEnd: null, outsideHours: 'hold' }),
  dryRun: z.boolean().default(false),
  triggers: z.array(TriggerInput).max(50).default([]),
  variants: z.array(VariantInput).min(1, 'Write the message').max(COMPLIANCE_LIMITS.variantsMax, `Use ${COMPLIANCE_LIMITS.variantsMax} versions or fewer`),
});

/** A PATCH names only what changes, so nothing is filled in with a default. */
export const AutomationUpdate = z.object({
  ...Object.fromEntries(Object.entries(AutomationInput.shape).map(([name, schema]) => [name, schema.removeDefault?.().optional() ?? schema.optional()])),
});

export const Automation = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  state: z.enum(AUTOMATION_STATES),
  triggerType: z.enum(TRIGGER_TYPES),
  matchMode: z.enum(['keywords', 'any']),
  keywords: z.array(z.string()),
  includeReactions: z.boolean(),
  priority: Count,
  linkMode: z.enum(['one_tap', 'two_tap']),
  linkType: z.enum(LINK_TYPES),
  linkUrl: z.string(),
  finalUrl: z.string(), // the exact address the shopper will open (PRD 4.11)
  linkStatus: z.enum(['unchecked', 'ok', 'failed']),
  tapButtonTitle: z.string(),
  linkButtonTitle: z.string(),
  publicReplyEnabled: z.boolean(),
  followupEnabled: z.boolean(),
  followupDelayMinutes: Count,
  followupText: z.string(),
  linkMessage: z.string(),
  schedule: ScheduleOut,
  dryRun: z.boolean(),
  triggers: z.array(Trigger),
  variants: z.array(Variant),
  winnerVariantId: Id.nullable(),
  warnings: z.array(SaveWarning),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const AutomationSummary = z.object({
  id: Id, name: z.string(), state: z.enum(AUTOMATION_STATES), triggerType: z.enum(TRIGGER_TYPES), linkMode: z.enum(['one_tap', 'two_tap']), mediaCount: Count, sends: Count, updatedAt: Timestamp,
});
export const AutomationListQuery = ListQuery.extend({ state: z.enum(AUTOMATION_STATES).optional() });

export const StateChange = z.object({ state: z.enum(AUTOMATION_STATES) });
export const PickWinner = z.object({ variantId: Id });

/** A leader is marked only after 100 sends per variant (PRD 6.5). taps is null where the link type can't count them. */
export const VariantStats = z.object({ variantId: Id, label: z.enum(VARIANT_LABELS), sends: Count, taps: Count.nullable(), visits: Count.nullable(), rate: z.number().min(0).nullable(), leader: z.boolean() });
export const AutomationStats = z.object({ automationId: Id, sends: Count, taps: Count.nullable(), variants: z.array(VariantStats) });

export const SendTest = z.object({ testerId: Id, variantLabel: z.enum(VARIANT_LABELS).optional() });
export const SendTestResult = z.object({ outcome: z.string(), reason: z.string() });

/** Checks a message as the owner types: filled in, and again with {first_name} empty. */
export const PreviewBody = z.object({
  body: required(VARIANT_BODY_MAX),
  buttonTitle: text(COMPLIANCE_LIMITS.buttonTitleChars * 4).default(''),
  linkUrl: text(2000).default(''),
});
export const PreviewProblem = z.object({ reason: z.string(), message: z.string() });
export const Preview = z.object({ filled: z.string(), withoutName: z.string(), bytes: Count, maxBytes: Count, problems: z.array(PreviewProblem) });

export const Tester = z.object({ id: Id, channel: Channel, label: z.string(), windowOpen: z.boolean(), addedAt: Timestamp });
export const TesterCode = z.object({ code: z.string(), expiresAt: Timestamp });
export const TesterCodeBody = z.object({ label: text(60).default('') });

export const IceBreaker = z.object({ question: required(80), templateBody: required(VARIANT_BODY_MAX) });
export const IceBreakers = z.object({ items: z.array(IceBreaker).max(COMPLIANCE_LIMITS.iceBreakersMax, `Use ${COMPLIANCE_LIMITS.iceBreakersMax} questions or fewer`) });

export const automationRoutes = {
  'automations.list': { method: 'GET', path: '/automations', access, query: AutomationListQuery, response: page(AutomationSummary) },
  'automations.create': { method: 'POST', path: '/automations', access, body: AutomationInput, status: 201, response: Automation },
  'automations.preview': { method: 'POST', path: '/automations/preview', access, body: PreviewBody, response: Preview },
  'automations.get': { method: 'GET', path: '/automations/:id', access, params: IdParams, response: Automation },
  'automations.update': { method: 'PATCH', path: '/automations/:id', access, params: IdParams, body: AutomationUpdate, response: Automation },
  'automations.remove': { method: 'DELETE', path: '/automations/:id', access, params: IdParams, status: 204, response: null },
  'automations.setState': { method: 'POST', path: '/automations/:id/state', access, params: IdParams, body: StateChange, response: Automation },
  'automations.pickWinner': { method: 'POST', path: '/automations/:id/winner', access, params: IdParams, body: PickWinner, response: Automation },
  'automations.stats': { method: 'GET', path: '/automations/:id/stats', access, params: IdParams, response: AutomationStats },
  'automations.sendTest': { method: 'POST', path: '/automations/:id/send-test', access, params: IdParams, body: SendTest, response: SendTestResult },
  'testers.list': { method: 'GET', path: '/testers', access, query: ListQuery, response: page(Tester) },
  'testers.createCode': { method: 'POST', path: '/testers/codes', access: MANAGERS, body: TesterCodeBody, status: 201, response: TesterCode },
  'testers.remove': { method: 'DELETE', path: '/testers/:id', access: MANAGERS, params: IdParams, status: 204, response: null },
  'iceBreakers.get': { method: 'GET', path: '/ice-breakers', access, response: IceBreakers },
  'iceBreakers.save': { method: 'PUT', path: '/ice-breakers', access, body: IceBreakers, response: IceBreakers },
};
