/**
 * Meta's limits and error codes, in one place. Limits follow PRD 4.3. Error codes follow the Graph API and
 * Messenger Platform references; where Instagram Login has not confirmed one (PRD 4.3 rows 16, 19 and 23,
 * and the validation codes in 4.4) it is marked "assumed", and the live check must confirm it.
 */
import crypto from 'node:crypto';
import { SimError } from '../base.mjs';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const toSeconds = (ms) => Math.floor(ms / 1000);

export const LIMITS = Object.freeze({
  codeMs: HOUR,
  shortTokenMs: HOUR,
  longTokenMs: 60 * DAY,
  refreshMinAgeMs: DAY,
  privateReplyWindowMs: 7 * DAY,
  messagingWindowMs: DAY,
  humanAgentWindowMs: 7 * DAY,
  privateRepliesPerHour: 750,
  sendPerSecond: 100,
  textBytes: 1000,
  buttonTextChars: 640,
  buttonsMax: 3,
  buttonTitleChars: 20,
  postbackPayloadChars: 1000,
  quickRepliesMax: 13,
  quickReplyTitleChars: 20,
  iceBreakersMax: 4,
  iceBreakerQuestionChars: 80,
  storyMs: DAY,
  publicReplyChars: 2200,
  bucPerImpression: 4800,
  bucWindowMs: DAY,
  webhookRetryMs: 36 * HOUR,
  webhookBatch: 1000,
  webhookTimeoutMs: 5000,
});

export const SCOPES = Object.freeze({
  basic: 'instagram_business_basic',
  messages: 'instagram_business_manage_messages',
  comments: 'instagram_business_manage_comments',
  insights: 'instagram_business_manage_insights',
  publish: 'instagram_business_content_publish',
});

/** What Bhava asks every account for (PRD 4.2). Publishing is never requested, but Meta would allow it. */
export const DEFAULT_SCOPES = Object.freeze([SCOPES.basic, SCOPES.messages, SCOPES.comments, SCOPES.insights]);

/** The scope each webhook field needs before an account can subscribe to it. */
export const WEBHOOK_FIELDS = Object.freeze({
  comments: SCOPES.comments,
  live_comments: SCOPES.comments,
  mentions: SCOPES.comments,
  messages: SCOPES.messages,
  message_reactions: SCOPES.messages,
  messaging_handover: SCOPES.messages,
  messaging_optins: SCOPES.messages,
  messaging_postbacks: SCOPES.messages,
  messaging_referral: SCOPES.messages,
  messaging_seen: SCOPES.messages,
  standby: SCOPES.messages,
  story_insights: SCOPES.insights,
});

export const INSIGHT_METRICS = Object.freeze(['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'follows', 'profile_visits', 'profile_activity', 'replies', 'navigation', 'accounts_engaged', 'follower_count', 'website_clicks', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time']);

export const ERRORS = Object.freeze({
  TOKEN_MISSING: { code: 104, message: 'An access token is required to request this resource.' },
  TOKEN_INVALID: { code: 190, message: 'Invalid OAuth access token - Cannot parse access token' },
  TOKEN_EXPIRED: { code: 190, subcode: 463, message: 'Error validating access token: Session has expired.' },
  TOKEN_REVOKED: { code: 190, subcode: 458, message: 'Error validating access token: The user has not authorized application.' },
  CLIENT_SECRET: { code: 101, message: 'Error validating client secret.' },
  BAD_GRANT: { code: 100, message: '(#100) grant_type is missing or not supported for this endpoint.' },
  TOKEN_TOO_YOUNG: { code: 100, message: '(#100) This access token is less than 24 hours old and cannot be refreshed yet.' }, // assumed
  PERMISSION: { code: 200, message: '(#200) Permissions error' },
  OBJECT_NOT_FOUND: { code: 100, subcode: 33, type: 'GraphMethodException', message: 'Unsupported request. Object with this ID does not exist, cannot be loaded due to missing permissions, or does not support this operation.' },
  INVALID_PARAM: { code: 100, message: '(#100) Invalid parameter' },
  UNKNOWN_PATH: { code: 2500, type: 'IGApiException', message: 'Unknown path components' },
  // Private replies: assumed for Instagram (PRD 4.4); these are the Messenger Platform's codes.
  ALREADY_REPLIED: { code: 10900, message: '(#10900) Activity already replied to' },
  REPLY_WINDOW_CLOSED: { code: 10901, message: '(#10901) Activity is too old to reply to' },
  CANNOT_REPLY: { code: 10903, message: "(#10903) This user can't reply to this activity" },
  // Messaging window: 10 is documented; 2534022 is the subcode Instagram reports.
  WINDOW_CLOSED: { code: 10, subcode: 2534022, message: '(#10) This message is sent outside of allowed window.' },
  RECIPIENT_UNAVAILABLE: { code: 551, subcode: 1545041, message: "(#551) This person isn't available right now." }, // assumed (PRD 4.6)
  // Rate limits (PRD 4.3 rows 17 to 19).
  APP_THROTTLED: { code: 4, message: '(#4) Application request limit reached' },
  USER_THROTTLED: { code: 17, message: '(#17) User request limit reached' },
  API_THROTTLED: { code: 32, message: '(#32) Page request limit reached' },
  RATE_LIMITED: { code: 613, message: '(#613) Calls to this API have exceeded the rate limit.' },
  BUC_THROTTLED: { code: 80002, type: 'IGApiException', message: '(#80002) There have been too many calls to this Instagram account. Wait a bit and try again.' },
  UNKNOWN: { code: 1, message: 'An unknown error occurred', transient: true },
});

const THROTTLES = new Map([ERRORS.APP_THROTTLED, ERRORS.USER_THROTTLED, ERRORS.API_THROTTLED, ERRORS.RATE_LIMITED, ERRORS.BUC_THROTTLED].map((e) => [e.code, e]));

export function graphErrorBody({ code, subcode, message, type = 'OAuthException', transient = false }) {
  return {
    error: {
      message,
      type,
      code,
      ...(subcode ? { error_subcode: subcode } : {}),
      ...(transient ? { is_transient: true } : {}),
      fbtrace_id: crypto.randomBytes(8).toString('base64url'),
    },
  };
}

export const graphError = (definition, message) => new SimError(400, graphErrorBody({ ...definition, message: message ?? definition.message }));

/** The body of an injected fault, in Graph's shape. code and subcode on the fault override the defaults. */
export function metaFaultBody({ kind, fault }) {
  if (kind === 'rate_limit') {
    const code = fault.code ?? ERRORS.APP_THROTTLED.code;
    const known = THROTTLES.get(code) ?? ERRORS.APP_THROTTLED;
    return graphErrorBody({ ...known, code, subcode: fault.subcode });
  }
  if (kind === 'bad_request') return graphErrorBody({ ...ERRORS.INVALID_PARAM, message: '(#100) The request body could not be parsed.' });
  return graphErrorBody({ ...ERRORS.UNKNOWN, code: fault.code ?? ERRORS.UNKNOWN.code, subcode: fault.subcode });
}
