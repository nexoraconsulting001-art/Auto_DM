import { z } from 'zod';
import { ADDON_FEATURES, AI_LIMITS, AI_OUTCOMES, AI_THRESHOLD, WHATSAPP_ACCOUNT_STATUSES, WHATSAPP_LIMITS, WHATSAPP_OPTIN_SOURCES } from '../addons.js';
import { Channel, WHATSAPP_OPTIN_PURPOSES } from '../compliance.js';
import { MANAGERS, OWNER_ONLY, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Timestamp, page, required, text } from './common.js';
import { ReasonCode } from './compliance.js';

/**
 * Phase 7: the AI replies and WhatsApp add-ons (PRD 6.11, 6.12), answered by src/modules/ai-replies and
 * src/modules/whatsapp-automation. Each is an entitlement an add-on switches on: starting and switching on are gated
 * (`feature`, or the handler for a setting that can also be switched off); reading, removing and disconnecting never
 * are, so what a business has stays manageable after the add-on ends.
 *
 * No route here sends a message. aiReplies.testQuestion asks the model and shows the answer; nothing goes to a shopper.
 * No answer carries a phone number, a hash of one, or an access token.
 */
const automations = staffWith('automations');
const AI = ADDON_FEATURES.aiReplies;
const WHATSAPP = ADDON_FEATURES.whatsapp;

export const FaqEntry = z.object({ id: Id, question: z.string(), answer: z.string(), active: z.boolean(), updatedAt: Timestamp });
export const FaqCreate = z.object({ question: required(300, 'Write the question'), answer: required(1000, 'Write the answer'), active: z.boolean().default(true) });
export const FaqUpdate = z.object({ question: required(300, 'Write the question'), answer: required(1000, 'Write the answer'), active: z.boolean() }).partial();

const Threshold = z.number().min(AI_THRESHOLD.min, `Use ${AI_THRESHOLD.min} or more`).max(AI_THRESHOLD.max, `Use ${AI_THRESHOLD.max} or less`);
/**
 * `configured` is whether a model provider is set for this installation; without one the add-on hands everything to a
 * person. `canEnable` is false until there is an active FAQ entry (the database refuses it too).
 */
export const AiSettings = z.object({ enabled: z.boolean(), threshold: Threshold, configured: z.boolean(), faqCount: Count, canEnable: z.boolean() });
export const AiSettingsSave = z.object({ enabled: z.boolean(), threshold: Threshold }).partial();

export const AiSource = z.object({ kind: z.enum(['faq', 'product']), id: Id, label: z.string() });
export const AiTestQuestion = z.object({ question: required(AI_LIMITS.questionChars, 'Write a question') });
/** What a shopper would have got: `wouldSend` false comes with the reason (ai.low_confidence, ai.ungrounded, ai.handoff, ai.provider_failed). Nothing is sent. */
export const AiTestAnswer = z.object({ answer: z.string(), sources: z.array(AiSource), score: z.number().min(0).max(1).nullable(), threshold: Threshold, wouldSend: z.boolean(), reason: ReasonCode });

export const AiLogEntry = z.object({
  id: z.number().int().positive(),
  channel: Channel,
  threadId: Id.nullable(),
  /** Both are '' once the inbox retention has passed. */
  question: z.string(),
  answer: z.string(),
  sourceIds: z.array(z.string()),
  score: z.number().min(0).max(1).nullable(),
  model: z.string(),
  outcome: z.enum(AI_OUTCOMES),
  reason: ReasonCode,
  at: Timestamp,
});
export const AiLogQuery = ListQuery.extend({ outcome: z.enum(AI_OUTCOMES).optional() });

/** `signupReady` is whether embedded signup is configured for this installation. No token and no id that could be used as one. */
export const WhatsappStatus = z.object({
  connected: z.boolean(),
  status: z.enum(WHATSAPP_ACCOUNT_STATUSES).nullable(),
  displayName: z.string(),
  displayNumber: z.string(),
  connectedAt: Timestamp.nullable(),
  signupReady: z.boolean(),
});
/** What the browser needs to open Meta's embedded signup. `state` comes back with the code, once, within a few minutes. */
export const WhatsappConnectStart = z.object({ appId: z.string(), configId: z.string(), state: z.string() });
const GraphId = z.string().regex(/^\d{5,40}$/, 'That id is not valid');
export const WhatsappConnectFinish = z.object({ code: required(2000, 'Finish the WhatsApp sign-up first'), state: required(200), wabaId: GraphId, phoneNumberId: GraphId });

const Keyword = text(WHATSAPP_LIMITS.keywordChars).min(1, 'Write a keyword');
/** One keyword set answers with one of the business's reels or with a link: exactly one. `message` may carry {link}. */
const KeywordTarget = { reelId: Id.nullable(), linkUrl: z.union([z.literal(''), z.string().trim().max(2000).regex(/^https:\/\/\S+$/i, 'Use an https link')]) };
export const WhatsappKeywordSet = z.object({ id: Id, keywords: z.array(z.string()), ...KeywordTarget, message: z.string(), active: z.boolean() });
export const WhatsappKeywordSetInput = z.object({
  id: Id.optional(),
  keywords: z.array(Keyword).min(1, 'Add a keyword').max(WHATSAPP_LIMITS.keywordsPerSet, `Use ${WHATSAPP_LIMITS.keywordsPerSet} keywords or fewer`),
  ...KeywordTarget,
  message: text(WHATSAPP_LIMITS.messageChars).default(''),
  active: z.boolean().default(true),
}).refine((set) => (set.reelId !== null) !== (set.linkUrl !== ''), { path: ['linkUrl'], message: 'Choose a reel or a link, not both' });
/** The whole list, in priority order: a set left out is removed. */
export const WhatsappKeywordsSave = z.object({ items: z.array(WhatsappKeywordSetInput).max(WHATSAPP_LIMITS.keywordSets, `Use ${WHATSAPP_LIMITS.keywordSets} keyword sets or fewer`) });
const KeywordList = z.object({ items: z.array(WhatsappKeywordSet) });

/** Who opted in, with nothing that identifies them: the number is stored only as a hash and is not shown. */
export const WhatsappOptin = z.object({ id: z.number().int().positive(), purpose: z.enum(WHATSAPP_OPTIN_PURPOSES), source: z.enum(WHATSAPP_OPTIN_SOURCES), optedInAt: Timestamp, withdrawnAt: Timestamp.nullable() });
export const WhatsappOptinsQuery = ListQuery.extend({ purpose: z.enum(WHATSAPP_OPTIN_PURPOSES).optional() });

export const aiReplyRoutes = {
  'faq.list': { method: 'GET', path: '/faq', access: automations, query: ListQuery, response: page(FaqEntry) },
  'faq.create': { method: 'POST', path: '/faq', access: automations, feature: AI, body: FaqCreate, status: 201, response: FaqEntry },
  'faq.update': { method: 'PATCH', path: '/faq/:id', access: automations, feature: AI, params: IdParams, body: FaqUpdate, response: FaqEntry },
  'faq.remove': { method: 'DELETE', path: '/faq/:id', access: automations, params: IdParams, status: 204, response: null },
  'aiReplies.settings': { method: 'GET', path: '/ai-replies', access: automations, response: AiSettings },
  'aiReplies.save': { method: 'PATCH', path: '/ai-replies', access: MANAGERS, body: AiSettingsSave, response: AiSettings },
  'aiReplies.testQuestion': { method: 'POST', path: '/ai-replies/test', access: automations, feature: AI, body: AiTestQuestion, response: AiTestAnswer },
  'aiReplies.log': { method: 'GET', path: '/ai-replies/log', access: automations, query: AiLogQuery, response: page(AiLogEntry) },
};

export const whatsappRoutes = {
  'whatsapp.status': { method: 'GET', path: '/whatsapp', access: MANAGERS, response: WhatsappStatus },
  'whatsapp.connectStart': { method: 'POST', path: '/whatsapp/connect', access: OWNER_ONLY, fresh: true, feature: WHATSAPP, response: WhatsappConnectStart },
  'whatsapp.connectFinish': { method: 'POST', path: '/whatsapp/connect/finish', access: OWNER_ONLY, fresh: true, feature: WHATSAPP, body: WhatsappConnectFinish, response: WhatsappStatus },
  'whatsapp.disconnect': { method: 'DELETE', path: '/whatsapp', access: OWNER_ONLY, fresh: true, status: 204, response: null },
  'whatsapp.keywords': { method: 'GET', path: '/whatsapp/keywords', access: automations, response: KeywordList },
  'whatsapp.saveKeywords': { method: 'PUT', path: '/whatsapp/keywords', access: automations, feature: WHATSAPP, body: WhatsappKeywordsSave, response: KeywordList },
  'whatsapp.optins': { method: 'GET', path: '/whatsapp/optins', access: MANAGERS, query: WhatsappOptinsQuery, response: page(WhatsappOptin) },
};

/** Which module answers which route. */
export const ADDON_ROUTE_OWNERS = Object.freeze({
  'ai-replies': Object.freeze(Object.keys(aiReplyRoutes)),
  'whatsapp-automation': Object.freeze(Object.keys(whatsappRoutes)),
});
