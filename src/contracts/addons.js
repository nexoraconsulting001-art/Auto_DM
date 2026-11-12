import { z } from 'zod';

/**
 * The two paid add-ons of Phase 7 (PRD 6.11 AI replies, 6.12 WhatsApp): their vocabulary, the AI provider's interface and
 * the rules both tracks share. Plain data and zod only, so the console and the owner app can use it too.
 *
 * Both are entitlements (`ai_replies`, `whatsapp_automation`: an add-on's row in tenant_features turns each on) and both
 * send only through the compliance gate. Neither module calls a provider's send itself.
 */
export const ADDON_FEATURES = Object.freeze({ aiReplies: 'ai_replies', whatsapp: 'whatsapp_automation' });

// ---- AI replies (PRD 6.11) ----

/** A draft scoring below the business's threshold is not sent (ai.low_confidence). The default is the PRD's; the floor is ours. */
export const AI_THRESHOLD = Object.freeze({ default: 0.8, min: 0.5, max: 1 });

/** A draft longer than this is not an answer to a DM. The gate's own limit (content.too_long) is on bytes and comes after. */
export const AI_LIMITS = Object.freeze({ questionChars: 1000, draftChars: 900, faqEntries: 50, products: 30, sources: 20, timeoutMs: 15_000, maxOutputTokens: 400 });

/**
 * AI_DRIVER. `none` is the default: the add-on reports "not configured", nothing is sent to any provider and every
 * unanswered DM goes to a person. Any other value names a wire format, one small file in src/adapters/ai/wire.
 * `http` is the same as the first wire format.
 */
export const AI_WIRE_FORMATS = Object.freeze(['chat_completions']);
export const AI_DRIVERS = Object.freeze(['none', 'http', ...AI_WIRE_FORMATS]);

/** ProviderError.kind for the AI provider. Each one ends in a handoff with ai.provider_failed; none is retried inside a request. */
export const AI_ERROR_KINDS = Object.freeze(['timeout', 'throttled', 'unavailable', 'refused', 'invalid_output']);

/**
 * What the model may be told about a product, and nothing else: name, price, stock status, sizes and its own link.
 * The adapter drops every other field before the request is built.
 */
export const AiProduct = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(200),
  pricePaise: z.number().int().min(0),
  inStock: z.boolean(),
  sizes: z.array(z.string().max(40)).max(30).default([]),
  url: z.string().max(2000),
});
export const AiFaqEntry = z.object({ id: z.number().int().positive(), question: z.string().min(1).max(300), answer: z.string().min(1).max(1000) });

/** answer(input). `question` is what the shopper wrote: data for the model, never instructions to it. */
export const AiAnswerInput = z.object({
  question: z.string().min(1).max(AI_LIMITS.questionChars),
  faq: z.array(AiFaqEntry).max(AI_LIMITS.faqEntries),
  products: z.array(AiProduct).max(AI_LIMITS.products).default([]),
  businessName: z.string().min(1).max(120),
  /** The seller's note the gate adds after the text, so the model does not write one of its own. */
  disclosure: z.string().max(200).default(''),
  /** A BCP 47 tag, or '' to answer in the language of the question. */
  language: z.string().max(20).default(''),
});

/** A source is 'faq:<id>' or 'product:<id>': an id that was in the request. */
export const AI_SOURCE = /^(faq|product):([1-9]\d{0,9})$/;
export const sourceId = (kind, id) => `${kind}:${id}`;

/** What answer() resolves to. `confidence` is the model's own score, 0 to 1. `usage.units` is what the meter counts (ai_units). */
export const AiAnswer = z.object({
  draft: z.string().min(1),
  sources: z.array(z.string().regex(AI_SOURCE)).max(AI_LIMITS.sources),
  confidence: z.number().min(0).max(1),
  usage: z.object({ units: z.number().int().min(0) }),
  model: z.string(),
});

/** Sources the answer names that were not in the request: another business's product, or an id made up. Any one makes it ai.ungrounded. */
export function unknownSources(answer, { faq = [], products = [] }) {
  const supplied = new Set([...faq.map((f) => sourceId('faq', f.id)), ...products.map((p) => sourceId('product', p.id))]);
  return answer.sources.filter((source) => !supplied.has(source));
}

/** ai_reply_log.outcome. `test` is "Ask a test question": nothing is sent and nothing is metered to the shopper. */
export const AI_OUTCOMES = Object.freeze(['answered', 'handed_off', 'dropped', 'failed', 'test']);

/**
 * Why an unanswered DM got no AI reply, as reason codes (src/contracts/compliance.js):
 *   ai.low_confidence    the score is under the threshold, or the model had no answer
 *   ai.ungrounded        the draft states a price, discount, stock level, delivery date or policy that is not in the FAQ
 *                        or the catalog, names a source that was not supplied, carries a link that is not the product's
 *                        own, or repeats an instruction from the shopper's message
 *   ai.handoff           a complaint, a refund or order problem, negative intent or a handoff word: never answered
 *   ai.provider_failed   the provider timed out, throttled, was unavailable, refused, or answered with something unusable;
 *                        also when no provider is configured
 * Each ends as a "Needs a human" item. A reply the gate then refuses keeps the gate's own code (window.closed, optout, ...).
 */
export const AI_REASONS = Object.freeze({ lowConfidence: 'ai.low_confidence', ungrounded: 'ai.ungrounded', handoff: 'ai.handoff', providerFailed: 'ai.provider_failed' });

/** Where each outcome's reasons come from: a test never has a job, and only an answer has one. */
export const AI_PURPOSE = 'ai_reply';

// ---- WhatsApp (PRD 6.12) ----

export const WHATSAPP_CHANNEL = 'whatsapp';
/** whatsapp_optins.source: where the yes was said. `keyword` is a shopper asking for updates in the chat itself. */
export const WHATSAPP_OPTIN_SOURCES = Object.freeze(['keyword', 'checkout', 'account', 'form', 'seller', 'import']);
export const WHATSAPP_ACCOUNT_STATUSES = Object.freeze(['active', 'reconnect', 'disabled']);
/** Every link a WhatsApp reply carries is the direct link with this source (PRD 6.6, 6.12). */
export const WHATSAPP_UTM_SOURCE = 'whatsapp';
export const WHATSAPP_LIMITS = Object.freeze({ keywordSets: 50, keywordsPerSet: 20, keywordChars: 40, messageChars: 1000, textBytes: 4096 });
/** Meta's error for a free-form message outside the 24 hour window. The channel reports it as kind 'window_closed'. */
export const WHATSAPP_WINDOW_CLOSED_CODE = 131047;
