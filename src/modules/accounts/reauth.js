import { AUTH_LIMITS, CODE_RULES } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { limit } from './shared.js';

/**
 * Re-auth (PRD 5.11: sensitive actions need a fresh biometric check or WhatsApp code). auth.reauthStart sends a code
 * bound to this person to their verified phone; auth.reauthVerify takes that code, or the device's re-auth secret, and
 * marks this session fresh for FRESH_MINUTES. A wrong answer is a 400 on the field, never a 401: the session is fine,
 * only the proof was not.
 */
export function reauthHandlers(ctx, { people, codes, devices, sendCode }) {
  const wrong = (field) => new ApiError('validation_failed', 'That didn’t match. Try again.', { fields: { [field]: 'That didn’t match. Try again.' } });

  return {
    'auth.reauthStart': async ({ user, req }) => {
      const [phone] = user.person_id ? await people.phonesOf(user.person_id) : [];
      if (!phone) return { sent: false, channel: 'none', expiresInSeconds: 0, resendInSeconds: 0 };
      await limit(ctx.platform, AUTH_LIMITS.codeSendsPerAddress, req.ip);
      await sendCode({ subject: phone, purpose: 'reauth', personId: user.person_id });
      return { sent: true, channel: 'whatsapp', expiresInSeconds: CODE_RULES.ttlMs / 1000, resendInSeconds: CODE_RULES.resendAfterMs / 1000 };
    },

    'auth.reauthVerify': async ({ body, user, req }) => {
      const code = body.code ?? '';
      const secret = body.deviceSecret ?? '';
      if (Boolean(code) === Boolean(secret)) throw new ApiError('validation_failed', 'Send the code or the device unlock, not both.');
      if (!user.person_id) throw wrong(code ? 'code' : 'deviceSecret');
      if (code) {
        const [phone] = await people.phonesOf(user.person_id);
        await limit(ctx.platform, AUTH_LIMITS.codeTriesPerAddress, req.ip);
        if (phone) await limit(ctx.platform, AUTH_LIMITS.codeTriesPerNumber, phone);
        if (!phone || !(await codes.check({ subject: phone, purpose: 'reauth', personId: user.person_id, code }))) {
          log.warn('accounts.code_refused', { purpose: 'reauth' });
          throw wrong('code');
        }
      } else if (!(await devices.secretMatches({ personId: user.person_id, deviceId: req.session?.deviceId ?? null, secret }))) {
        log.warn('accounts.device_unlock_refused', { personId: user.person_id });
        throw wrong('deviceSecret');
      }
      const freshUntil = await ctx.repos.sessions.markFresh(req.sessionToken);
      if (!freshUntil) throw new ApiError('unauthorized');
      log.info('accounts.reauth', { personId: user.person_id, by: code ? 'code' : 'device' });
      return { freshUntil };
    },
  };
}
