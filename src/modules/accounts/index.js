import { notBuilt } from '../not-built.js';

/**
 * Seller accounts without passwords, and app sessions (PRD 5.11, 10.2, 10.3, 10.6). One track owns this folder and
 * edits nothing outside it. The contract it builds against:
 *
 *   src/contracts/accounts.js        the numbers and pure rules: CODE_RULES, AUTH_LIMITS, FRESH_MINUTES, the keyed hashes,
 *                                    sameSecret, PKCE, toE164, isBelowMinimum, reviewCodeProblem
 *   src/contracts/api/auth.js        the routes and their shapes; app.js for app.requirements; provider.js for AUTH_PATHS
 *   migrations 500, 501              people, person_identities, seller_login_codes, review_logins, review_login_uses,
 *                                    account_deletion_requests, token_families, refresh_tokens, auth_devices, auth_handoffs,
 *                                    app_min_versions: all platform-only, reached through db.platform
 *   repos.sessions                   create (cookie), createAccess, markFresh, revoke: the session rows themselves
 *   repos.tenants.findSession        how every request finds its session; already honours a revoked family and removed_at
 *   repos.appVersions                minimum, set, list: the router already answers 426 from it
 *   ctx.google.signIn, ctx.apple.signIn   the checked sign-in adapters (src/adapters/google, src/adapters/apple)
 *
 * What goes where:
 *
 *   sign-in.js       auth.start and auth.verify: the WhatsApp code. auth.apple. The browser routes in AUTH_PATHS (mounted in
 *                    beforeTenant, on PLATFORM_APP_HOST) and auth.exchange, which ends them.
 *   people.js        finding or making the person for a verified identity; tying their seller accounts together;
 *                    making the first business for someone new; auth.linkIdentity.
 *   tokens.js        refresh families: issuing, rotating (auth.refresh), detecting reuse, revoking.
 *   devices.js       auth.devices, auth.revokeDevice, auth.enableDeviceUnlock.
 *   reauth.js        auth.reauthStart and auth.reauthVerify.
 *   deletion.js      auth.deleteAccount and the job that carries a request out.
 *   review-login.js  App Review's fixed code.
 *   min-versions.js  app.requirements.
 *
 * Rules the tests will hold this folder to:
 *
 * Codes. Six digits (newCode), stored only as codeHash, used once, dead after CODE_RULES.ttlMs, and refused after
 * CODE_RULES.maxAttempts wrong tries: count the try before comparing, in one statement, so two racing tries cannot both
 * be the fifth. Compare with sameSecret. Limit sends and tries per number and per address with platform.rateLimit.hit
 * and AUTH_LIMITS. A code is never logged, never returned, never put in an error. auth.start answers the same body, in
 * about the same time, for a number with an account and one without, sent or not; so does a refused auth.verify
 * (401 `unauthorized`, one sentence for every reason). Codes go out through the seller notifications interface
 * (PRD 5.13, the notifications contract), from the platform's own number: never by calling the WhatsApp adapter here,
 * and never by SMS.
 *
 * People. A verified identity (kind, subject) is exactly one person. Signing in with a verified phone ties that person
 * to every seller account whose phone equals it (localPhone) and that is not removed: set users.person_id, and write the
 * memberships pair between each two of them, as the password path in repos.users does. Never tie anything to a phone,
 * email or account that this person did not just prove: an owner can type anyone's number onto a staff account. A
 * Google or Apple identity reaches accounts only through a person already tied to them, or through an invitation to
 * that verified email (src/modules/team). Someone with no seller account anywhere gets a new business of account type
 * creator on the Free plan, as its owner (F-109), and the session says `created`.
 *
 * Sessions. For transport bearer: one token_families row per sign-in, a refresh token (newToken, stored as tokenHash,
 * config.refreshTokenDays) and an access session (repos.sessions.createAccess, config.accessTokenMinutes, fresh after a
 * sign-in or re-auth, not after a refresh). auth.refresh marks the token used and writes its replacement in one
 * transaction; a token that is already used revokes the family ('token_reuse') and every session of it, and answers 401
 * (P-05). For transport cookie: auth.login(req, res, user) from ctx.auth, on the same origin only (sameOriginOnly in
 * src/auth.js), as the console does today. Removing a team member, revoking a device and deleting an account revoke the
 * person's families at once; request lookups already refuse a session whose family is revoked.
 *
 * Re-auth. auth.reauthVerify takes a fresh code (purpose reauth, bound to the person) or the device's re-auth secret
 * (auth_devices.reauth_secret_hash, compared with sameSecret, limited by AUTH_LIMITS.deviceSecretTries), then calls
 * repos.sessions.markFresh. The secret is made by auth.enableDeviceUnlock, returned once, and only ever releases what
 * the device already holds: it never signs anyone in.
 *
 * Review login. reviewCodeProblem decides; the fixed code works only for the review number with the flag on, opens only
 * the demo business, and every try of it on any number is a row in review_login_uses (F-50). The row comes from
 * REVIEW_LOGIN_PHONE and REVIEW_LOGIN_CODE_HASH at start.
 *
 * Deleting an account (P-26). The request is a row in account_deletion_requests due in DELETION_GRACE_DAYS, an audit
 * row in every business the person works at, an alert to ops (repos.alerts.raise, audience ops), and the timeline in
 * the answer. The person's sessions end at once. A sole owner's business is not deleted here: ops are told.
 *
 * Logs hold ids only: no number, email, code, token or name.
 */
export const accounts = {
  name: 'accounts',
  api: () => notBuilt(
    'auth.start', 'auth.verify', 'auth.exchange', 'auth.apple', 'auth.refresh',
    'auth.devices', 'auth.revokeDevice', 'auth.reauthStart', 'auth.reauthVerify', 'auth.enableDeviceUnlock',
    'auth.linkIdentity', 'auth.deleteAccount',
    'app.requirements',
  ),
};
