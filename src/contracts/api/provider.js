import { z } from 'zod';
import { Timestamp, text } from './common.js';

/**
 * What Meta and Caddy call, outside /api/v1 and before any business is known. Mount these in a module's beforeTenant
 * at these paths: Meta's dashboard, the simulator and the connect flow all use them.
 * Parse each entry and each change on its own, so one malformed item never takes the rest of a delivery with it.
 */
const ObjectId = z.union([z.string().min(1), z.number().transform(String)]);
const Person = z.object({ id: ObjectId, username: z.string().optional(), name: z.string().optional() });

export const WebhookEnvelope = z.object({ object: z.string(), entry: z.array(z.unknown()).max(5000) });
export const WebhookEntry = z.object({ id: ObjectId, time: z.number().optional(), changes: z.array(z.unknown()).optional(), messaging: z.array(z.unknown()).optional() });
export const WebhookChange = z.object({ field: z.string(), value: z.unknown() });

/** The value of a change with field "comments". verb is "edited" or "remove" where Meta reports those (to confirm). */
export const CommentValue = z.object({
  id: ObjectId,
  text: z.string().default(''),
  from: Person,
  media: z.object({ id: ObjectId, media_product_type: z.string().optional() }),
  parent_id: ObjectId.optional(),
  verb: z.string().optional(),
});

/** The value of a Page's change with field "feed". */
export const FeedValue = z.object({
  item: z.string(),
  verb: z.string(),
  comment_id: ObjectId.optional(),
  post_id: ObjectId.optional(),
  parent_id: ObjectId.optional(),
  from: Person.optional(),
  message: z.string().default(''),
  created_time: z.number().optional(),
});

/** One item of entry.messaging: a DM, a story reply or mention (in message), a button tap (postback), or a read receipt (read, to confirm for Instagram Login). */
export const MessagingEvent = z.object({
  sender: z.object({ id: ObjectId }),
  recipient: z.object({ id: ObjectId }),
  timestamp: z.number(),
  message: z.object({
    mid: z.string(),
    text: z.string().optional(),
    is_echo: z.boolean().optional(),
    reply_to: z.object({ story: z.object({ id: ObjectId, url: z.string().optional() }).optional() }).optional(),
    attachments: z.array(z.object({ type: z.string(), payload: z.object({ url: z.string().optional() }).optional() })).optional(),
    quick_reply: z.object({ payload: z.string() }).optional(),
  }).optional(),
  postback: z.object({ mid: z.string().optional(), title: z.string().optional(), payload: z.string() }).optional(),
  read: z.object({ mid: z.string().optional(), watermark: z.number().optional() }).optional(),
});

export const OAuthCallbackQuery = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() });
export const SignedRequestBody = z.object({ signed_request: z.string().max(10_000) });
/** A signed_request's payload, once verifySignedRequest has passed it. */
export const SignedRequestPayload = z.object({ algorithm: z.literal('HMAC-SHA256'), user_id: ObjectId, issued_at: z.number().optional() });
export const DeletionAnswer = z.object({ url: z.string(), confirmation_code: z.string() });
export const DeletionStatus = z.object({ status: z.enum(['requested', 'completed']), requestedAt: Timestamp, completedAt: Timestamp.nullable() });
export const TlsAskQuery = z.object({ domain: text(253) });

export const PROVIDER_PATHS = Object.freeze({
  webhook: '/webhook',
  instagramCallback: '/oauth/instagram/callback',
  facebookCallback: '/oauth/facebook/callback',
  deauthorize: '/meta/deauthorize',
  deletion: '/meta/deletion',
  deletionStatus: '/meta/deletion/:code',
  tlsAsk: '/tls/ask',
});
