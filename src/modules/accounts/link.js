import { AUTH_LIMITS, maskEmail, maskPhone, toE164 } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { writeAudit } from '../audit/index.js';
import { verifyApple } from './sign-in.js';
import { limit } from './shared.js';

const LABELS = { google: 'Google account', apple: 'Apple ID' };

/** A person's identities as Settings shows them: masked, enough to recognise and not enough to use. */
export async function identitiesView(people, personId) {
  return (await people.identities(personId)).map((i) => ({
    kind: i.kind,
    label: i.kind === 'phone' ? maskPhone(i.subject) : (i.email ? maskEmail(i.email) : LABELS[i.kind]),
    verifiedAt: i.verified_at,
  }));
}

/**
 * auth.linkIdentity (PRD 5.11: one account can link both Google and a phone number; either signs in to the same
 * account). The identity is proved first, then added: a phone with a code sent to it, Google with a hand-off code from
 * a browser sign-in started with purpose "link", Apple with its identity token. An identity that already belongs to
 * another person is refused with conflict, and only after it was proved, so a stranger cannot ask whether a number has
 * an account. After a link the person's accounts are brought up to date: a newly verified number reaches the seller
 * accounts with that number, and an email its invitations.
 */
export function linkHandlers(ctx, { people, codes, handoffs, sendCode }) {
  const wrong = (field) => new ApiError('validation_failed', 'That didn’t match. Try again.', { fields: { [field]: 'That didn’t match. Try again.' } });

  async function done(personId, user, kind) {
    await people.reconcile(personId);
    await ctx.db.tx((t) => writeAudit(t, { actor: `user:${user.id}`, action: 'account.identity_linked', target: `person:${personId}`, details: { kind } }));
    log.info('accounts.identity_linked', { personId, kind });
    return { identities: await identitiesView(people, personId), pending: false };
  }

  return {
    'auth.linkIdentity': async ({ body, user, req }) => {
      const personId = user.person_id;
      if (!personId) throw new ApiError('conflict', 'Sign in with a WhatsApp code or Google first.');

      if (body.kind === 'phone') {
        const phone = toE164(body.phone);
        if (!phone) throw new ApiError('validation_failed', 'Enter a mobile number with its country code.', { fields: { phone: 'Enter a mobile number with its country code.' } });
        if (!body.code) {
          await limit(ctx.platform, AUTH_LIMITS.codeSendsPerAddress, req.ip);
          await sendCode({ subject: phone, purpose: 'link', personId });
          return { identities: await identitiesView(people, personId), pending: true };
        }
        await limit(ctx.platform, AUTH_LIMITS.codeTriesPerAddress, req.ip);
        await limit(ctx.platform, AUTH_LIMITS.codeTriesPerNumber, phone);
        if (!(await codes.check({ subject: phone, purpose: 'link', personId, code: body.code }))) throw wrong('code');
        await people.attach(personId, { kind: 'phone', subject: phone });
        return done(personId, user, 'phone');
      }

      if (body.kind === 'google') {
        await limit(ctx.platform, AUTH_LIMITS.providerSignInsPerAddress, req.ip);
        const owner = await handoffs.take({ code: body.code, verifier: body.verifier, purpose: 'link' });
        if (!owner) throw wrong('code');
        if (owner !== personId) {
          const google = (await people.identities(owner)).find((i) => i.kind === 'google');
          if (!google) throw new ApiError('conflict', 'That sign-in already belongs to another account.');
          await people.attach(personId, { kind: 'google', subject: google.subject, email: google.email });
        }
        return done(personId, user, 'google');
      }

      await limit(ctx.platform, AUTH_LIMITS.providerSignInsPerAddress, req.ip);
      const who = await verifyApple(ctx, body).catch((err) => {
        if (err?.code === 'unauthorized') throw wrong('identityToken');
        throw err;
      });
      await people.attach(personId, { kind: 'apple', subject: who.sub, email: who.emailVerified && !who.privateEmail ? who.email : '' });
      return done(personId, user, 'apple');
    },
  };
}
