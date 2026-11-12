import { z } from 'zod';
import { SessionOperator } from './ops.js';
import { ACCOUNT_TYPES, APPS, DEVICE_ID, DEVICE_PLATFORMS, IDENTITY_KINDS, PKCE_VERIFIER } from '../accounts.js';
import { PERMISSIONS, PUBLIC, SIGNED_IN } from './access.js';
import { Id, IdParams, Timestamp, text } from './common.js';

/**
 * Signing in (PRD 5.11, 10.2, 10.3, 10.6). There are no passwords: a person proves who they are with a WhatsApp code
 * to their phone, with Google, or with Apple, and gets a session in one of their businesses. The numbers and pure
 * rules are in src/contracts/accounts.js; the work is in src/modules/accounts.
 *
 * Two ways to carry a session, chosen with `transport`:
 *   bearer  the owner app: an access token (ACCESS_TOKEN_MINUTES, sent as Authorization: Bearer) and a refresh
 *           token (REFRESH_TOKEN_DAYS, kept in SecureStore, replaced on every use)
 *   cookie  the web console: an httpOnly cookie plus the returned CSRF token, as before
 *
 * The routes marked noBusiness are answered before anyone is signed in, on PLATFORM_APP_HOST where the address names
 * no business: their handlers work through db.platform. On a business's own address they behave the same, except
 * that the session they open is in that business, and a person who has no account there is refused.
 *
 * Bad input to a sign-in route is treated as a wrong code rather than a validation error, so a try learns nothing
 * about which part was wrong, and an unknown number gets the answer a known one gets.
 *
 * auth.login is phone and password, from Phase 0. It exists only while PASSWORD_LOGIN is on (tests and local runs):
 * otherwise the server answers 404 for it, and no production server starts with it on.
 */
export const LoginBody = z.object({
  phone: z.string().max(20).catch(''),
  password: z.string().max(200).catch(''),
  transport: z.enum(['bearer', 'cookie']).catch('bearer'),
});

export const SessionUser = z.object({
  id: Id,
  name: z.string(),
  phone: z.string(),
  role: z.enum(['owner', 'manager', 'staff', 'customer']),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
});

export const SessionBusiness = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  plan: z.string(),
  logoUrl: z.string().default(''),
  /** Seller or Creator: the same app, with the screens their plan and role allow (P-69). */
  accountType: z.enum(ACCOUNT_TYPES).default('seller'),
});

/**
 * `csrf` is present on cookie sessions: send it back as the x-csrf-token header on every change.
 * `freshUntil` is when the last re-auth stops counting, or null: routes marked fresh answer `reauth_required` after it.
 */
export const CurrentSession = z.object({
  user: SessionUser,
  business: SessionBusiness,
  csrf: z.string().optional(),
  freshUntil: Timestamp.nullable().optional(),
  /** Set when Bhava's team opened this session (PRD 5.10, 5.17): the console shows its banner. See SessionOperator in ops.js. */
  operator: SessionOperator.nullable().optional(),
});

/** `token` and `expiresInDays` are present for transport "bearer". */
export const LoginResult = CurrentSession.extend({ token: z.string().optional(), expiresInDays: z.number().int().optional() });

/** A business this seller works at. Send its id as X-Tenant-Id to work in it; the logo is workspace identity only. */
export const Membership = z.object({ id: Id, slug: z.string(), name: z.string(), role: z.enum(['owner', 'manager', 'staff']), logoUrl: z.string(), current: z.boolean() });

const Transport = z.enum(['bearer', 'cookie']).catch('bearer');
const loose = (max) => z.string().max(max).catch('');

/** The device signing in. `id` is chosen by the app at install and never changes; `name` is what Settings > Devices shows ("Pixel 8"). */
export const DeviceInput = z.object({
  id: z.string().regex(DEVICE_ID),
  name: text(80).default(''),
  platform: z.enum(DEVICE_PLATFORMS),
  app: z.enum(APPS).default('owner'),
  appVersion: text(20).default(''),
});
/** A device that cannot be read is no device: the session still opens, as a browser's does. */
const OptionalDevice = DeviceInput.optional().catch(undefined);

export const CodeStart = z.object({ phone: loose(20) });
/**
 * The same for every number, with or without an account, sent or not. `alternatives` are the other ways in, for
 * "Didn't get it?": there is no SMS (F-118).
 */
export const CodeStarted = z.object({
  sent: z.literal(true),
  channel: z.literal('whatsapp'),
  expiresInSeconds: z.number().int(),
  resendInSeconds: z.number().int(),
  alternatives: z.array(z.enum(['google', 'apple'])),
});

/** `tenantId` asks for the session to open in that business; without it, the one the person used last. */
const Opens = { transport: Transport, device: OptionalDevice, tenantId: Id.optional().catch(undefined) };
export const CodeVerify = z.object({ phone: loose(20), code: loose(12), ...Opens });
export const HandoffExchange = z.object({ code: loose(200), verifier: z.string().regex(PKCE_VERIFIER).catch(''), ...Opens });
/** `nonce` is the raw value whose SHA-256 the app gave Apple; `name` arrives from Apple on the first sign-in only. */
export const AppleSignIn = z.object({ identityToken: loose(5000), nonce: loose(200), name: text(80).optional().catch(undefined), ...Opens });

/**
 * A new session. For transport "bearer": accessToken, accessExpiresInSeconds and refreshToken. For "cookie": csrf.
 * `created` is true when this sign-in made the person's first business (a Creator account on the Free plan, F-109).
 * `deviceUnlock` says whether this device already holds a re-auth secret, so the app knows whether to offer it (F-110).
 */
export const AuthSession = CurrentSession.extend({
  accessToken: z.string().optional(),
  accessExpiresInSeconds: z.number().int().optional(),
  refreshToken: z.string().optional(),
  businesses: z.array(Membership),
  created: z.boolean().default(false),
  deviceUnlock: z.boolean().default(false),
});

export const RefreshBody = z.object({ refreshToken: loose(200) });
/** The old refresh token is dead the moment this is answered. Presenting it again revokes the whole family (P-05). */
export const Refreshed = z.object({ accessToken: z.string(), accessExpiresInSeconds: z.number().int(), refreshToken: z.string() });

export const AuthDevice = z.object({
  id: Id,
  name: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  app: z.enum(APPS),
  appVersion: z.string(),
  lastSeenAt: Timestamp,
  /** The device this request came from. */
  current: z.boolean(),
  deviceUnlock: z.boolean(),
});

/** `sent` is false when the person has no verified phone (Google or Apple only): the app then offers device unlock, or adding a phone. */
export const ReauthStarted = z.object({ sent: z.boolean(), channel: z.enum(['whatsapp', 'none']), expiresInSeconds: z.number().int(), resendInSeconds: z.number().int() });
/** Exactly one of the two: the code just sent, or the secret the app keeps behind fingerprint or face unlock. */
export const ReauthVerify = z.object({ code: loose(12).optional(), deviceSecret: loose(200).optional() });
export const Fresh = z.object({ freshUntil: Timestamp });

/** Returned once. The app keeps it in SecureStore behind fingerprint or face unlock; the server keeps only its hash. */
export const DeviceUnlock = z.object({ deviceSecret: z.string() });

/**
 * Adding a second way in to the same account. A phone takes two calls: the first with the number sends a code
 * (`pending` true), the second with the number and the code links it. Google sends the hand-off code and verifier
 * from a browser sign-in started with purpose "link"; Apple its identity token and nonce.
 * An identity that already belongs to another person is refused with `conflict`: accounts are never merged here.
 */
export const LinkIdentity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('phone'), phone: text(20), code: text(12).optional() }),
  z.object({ kind: z.literal('google'), code: text(200), verifier: z.string().regex(PKCE_VERIFIER) }),
  z.object({ kind: z.literal('apple'), identityToken: text(5000), nonce: text(200) }),
]);
/** `label` is masked: enough to recognise, not enough to use. */
export const Identity = z.object({ kind: z.enum(IDENTITY_KINDS), label: z.string(), verifiedAt: Timestamp });
export const Identities = z.object({ identities: z.array(Identity), pending: z.boolean().default(false) });

export const DeleteAccount = z.object({ confirm: z.literal('DELETE', { error: 'Type DELETE to confirm' }) });
/** The timeline shown after the request (P-26): when it was asked, and when the account will be gone unless it is cancelled by signing in again. */
export const DeletionRequest = z.object({ status: z.enum(['requested', 'cancelled', 'completed']), requestedAt: Timestamp, dueAt: Timestamp });

export const authRoutes = {
  'auth.login': { method: 'POST', path: '/auth/login', access: PUBLIC, body: LoginBody, status: 201, response: LoginResult },
  /** Sends a 6-digit code on WhatsApp from the platform's own number, through the notifications interface. */
  'auth.start': { method: 'POST', path: '/auth/start', access: PUBLIC, noBusiness: true, body: CodeStart, status: 202, response: CodeStarted },
  'auth.verify': { method: 'POST', path: '/auth/verify', access: PUBLIC, noBusiness: true, body: CodeVerify, status: 201, response: AuthSession },
  /** The end of a browser sign-in: the single-use code the callback handed to the app, with the PKCE verifier. */
  'auth.exchange': { method: 'POST', path: '/auth/exchange', access: PUBLIC, noBusiness: true, body: HandoffExchange, status: 201, response: AuthSession },
  'auth.apple': { method: 'POST', path: '/auth/apple', access: PUBLIC, noBusiness: true, body: AppleSignIn, status: 201, response: AuthSession },
  'auth.refresh': { method: 'POST', path: '/auth/refresh', access: PUBLIC, noBusiness: true, body: RefreshBody, status: 201, response: Refreshed },
  'auth.me': { method: 'GET', path: '/auth/me', access: SIGNED_IN, response: CurrentSession },
  /** Ends this session and, for an app, its refresh family. */
  'auth.logout': { method: 'POST', path: '/auth/logout', access: SIGNED_IN, status: 204, response: null },
  'auth.businesses': { method: 'GET', path: '/auth/businesses', access: SIGNED_IN, response: z.object({ businesses: z.array(Membership) }) },
  'auth.devices': { method: 'GET', path: '/auth/devices', access: SIGNED_IN, response: z.object({ devices: z.array(AuthDevice) }) },
  /** Signs that device out everywhere at once (P-08). Revoking is never held up by a re-auth. */
  'auth.revokeDevice': { method: 'DELETE', path: '/auth/devices/:id', access: SIGNED_IN, params: IdParams, status: 204, response: null },
  'auth.reauthStart': { method: 'POST', path: '/auth/reauth/start', access: SIGNED_IN, status: 202, response: ReauthStarted },
  'auth.reauthVerify': { method: 'POST', path: '/auth/reauth/verify', access: SIGNED_IN, body: ReauthVerify, response: Fresh },
  'auth.enableDeviceUnlock': { method: 'POST', path: '/auth/device-unlock', access: SIGNED_IN, fresh: true, status: 201, response: DeviceUnlock },
  'auth.linkIdentity': { method: 'POST', path: '/auth/identities', access: SIGNED_IN, fresh: true, body: LinkIdentity, response: Identities },
  'auth.deleteAccount': { method: 'POST', path: '/auth/delete-account', access: SIGNED_IN, fresh: true, body: DeleteAccount, status: 202, response: DeletionRequest },
};
