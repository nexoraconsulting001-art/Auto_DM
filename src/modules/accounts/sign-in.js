import { AUTH_LIMITS, CODE_RULES, toE164, tokenHash } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { IdTokenError } from '../../adapters/oidc.js';
import { log } from '../../platform/log.js';
import { limit, refused } from './shared.js';

const APPLE_NONCE_WINDOW_MS = 15 * 60_000;

/**
 * Signing in (PRD 5.11, 10.2, 10.3, 10.6): auth.start and auth.verify (the WhatsApp code), auth.exchange (the end of a
 * browser sign-in with Google), auth.apple and auth.refresh.
 *
 * auth.start does the same work for every number that can be read, with an account or without: it writes the code row
 * and sends the code (someone new gets a business when they verify it). So the answer, and the time it takes, say
 * nothing about whether a number has an account. Over a limit the answer is 429 for any number. A refused verify is one
 * 401 sentence for every reason, and it looks nothing up about accounts before the code has matched.
 */
export function signInHandlers(ctx, services) {
  const { codes, people, opener, handoffs, tokens, review } = services;
  const alternatives = () => ['google', ...(ctx.apple?.signIn?.configured ? ['apple'] : [])];
  const started = () => ({
    sent: true,
    channel: 'whatsapp',
    expiresInSeconds: CODE_RULES.ttlMs / 1000,
    resendInSeconds: CODE_RULES.resendAfterMs / 1000,
    alternatives: alternatives(),
  });

  /** Sends a code for `purpose` unless one is still waiting; the per-number limit counts only codes that go out. */
  async function sendCode({ subject, purpose, personId = null }) {
    if (await codes.waiting({ subject, purpose, personId })) return;
    await limit(ctx.platform, AUTH_LIMITS.codeSendsPerNumber, subject);
    const code = await codes.issue({ subject, purpose, personId });
    if (code) await codes.send({ subject, code, purpose });
  }

  return {
    sendCode,

    'auth.start': async ({ body, req }) => {
      await limit(ctx.platform, AUTH_LIMITS.codeSendsPerAddress, req.ip);
      const phone = toE164(body.phone);
      if (phone) await sendCode({ subject: phone, purpose: 'signin' });
      return started();
    },

    'auth.verify': async ({ body, req, res }) => {
      await limit(ctx.platform, AUTH_LIMITS.codeTriesPerAddress, req.ip);
      const phone = toE164(body.phone);
      if (phone) await limit(ctx.platform, AUTH_LIMITS.codeTriesPerNumber, phone);
      const { login } = await review.check({ phone, code: body.code, ip: req.ip });
      if (login) {
        const { personId, account } = await review.account(login);
        return opener.open({ req, res, personId, transport: body.transport, device: body.device, via: 'review', review: account });
      }
      const ok = phone ? await codes.check({ subject: phone, purpose: 'signin', code: body.code }) : false;
      if (!ok) {
        log.warn('accounts.code_refused', { purpose: 'signin' });
        throw refused();
      }
      const { personId } = await people.findOrMake({ kind: 'phone', subject: phone });
      return opener.open({ req, res, personId, transport: body.transport, device: body.device, tenantId: body.tenantId, via: 'whatsapp' });
    },

    'auth.exchange': async ({ body, req, res }) => {
      await limit(ctx.platform, AUTH_LIMITS.providerSignInsPerAddress, req.ip);
      const personId = await handoffs.take({ code: body.code, verifier: body.verifier, purpose: 'signin' });
      if (!personId) {
        log.warn('accounts.handoff_refused', { purpose: 'signin' });
        throw refused();
      }
      return opener.open({ req, res, personId, transport: body.transport, device: body.device, tenantId: body.tenantId, via: 'google' });
    },

    'auth.apple': async ({ body, req, res }) => {
      await limit(ctx.platform, AUTH_LIMITS.providerSignInsPerAddress, req.ip);
      const who = await verifyApple(ctx, body);
      const email = who.emailVerified && !who.privateEmail ? who.email : '';
      const { personId } = await people.findOrMake({ kind: 'apple', subject: who.sub, email, name: body.name ?? '' });
      return opener.open({ req, res, personId, transport: body.transport, device: body.device, tenantId: body.tenantId, via: 'apple' });
    },

    'auth.refresh': async ({ body, req }) => {
      await limit(ctx.platform, AUTH_LIMITS.refreshesPerAddress, req.ip);
      if (!body.refreshToken) throw new ApiError('unauthorized');
      return tokens.rotate(body.refreshToken);
    },
  };
}

/**
 * Checks an Apple identity token: the signature against Apple's keys, issuer, audience, expiry, and the nonce, which
 * also opens one sign-in only. Keys Apple could not give right now are worth another try; anything else is a refusal.
 */
export async function verifyApple(ctx, { identityToken, nonce }) {
  let who;
  try {
    who = await ctx.apple.signIn.verify(identityToken, { nonce });
  } catch (err) {
    if (!(err instanceof IdTokenError)) throw err;
    log.warn('accounts.apple_refused', { kind: err.kind });
    if (err.retryable) throw new ApiError('internal', 'Sign in with Apple isn’t reachable right now. Try again in a minute.');
    throw refused();
  }
  const once = await ctx.platform.rateLimit.hit('seller_apple_nonce', tokenHash(nonce), { limit: 1, windowMs: APPLE_NONCE_WINDOW_MS });
  if (!once.allowed) {
    log.warn('accounts.apple_refused', { kind: 'nonce_reused' });
    throw refused();
  }
  return who;
}
