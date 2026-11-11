import { tenantId } from '../tenancy.js';

/**
 * Shopper consent (PRD 9.18, India's DPDP Act 2023), as the rest of the code asks about it: platform.consent.
 * This file is the interface. The answers come from the consent module (src/modules/consent), which registers itself in its
 * setup(ctx) hook with platform.consent.use(provider) and owns the tables of migration 411. Until it has, every question is
 * answered no (nothing is sent, no tag loads) and every write refuses with ConsentNotReadyError: consent is never assumed
 * and never silently dropped.
 *
 * Consent is per business and per purpose. A yes at one business never counts at another (9.22, S-104), marketing needs its
 * own yes per channel (S-60, S-64), and taking it back is one call, as easy as giving it.
 *
 * A person (`subject`) is any of { shopperId, phone, email, visitorId }: a signed-in shopper, a guest known by the phone or
 * email typed at checkout, or a browser. The provider stores phones and emails only as keyed hashes.
 *
 *   allows({ purpose, channel?, ...subject }) -> { granted, answered, reason }
 *       purpose  'fulfilment' | 'order_updates' | 'marketing' | 'analytics_ads'
 *       channel  'whatsapp' | 'email', for order_updates and marketing
 *       `answered` is false when the person was never asked. The shopper-message gate asks this before every send.
 *   analyticsAndAds({ visitorId?, shopperId? }) -> { granted, answered, reason }
 *       The Phase 2 question (7.14): tags, pixels and server events ask this and nothing else.
 *   record({ subject, choices, noticeVersion, source, orderId? }, t?) -> { recorded }
 *       choices  [{ purpose, channel?, granted }]: one ledger row each. Pass the open transaction `t` so the choices
 *                commit with the order or sign-in they were made at (S-59).
 *       source   'sign_in' | 'checkout' | 'account' | 'banner' | 'unsubscribe' | 'reply' | 'seller' | 'migration'
 *   revoke({ subject, purpose, channel?, source }, t?) -> { recorded }
 *       The same as recording a no. Stops sends from the next one on.
 *   status(subject) -> [{ purpose, channel, granted, noticeVersion, at }]      what holds now, for the account page
 *   notice() -> { version, bodyEn, bodyHi } | null                              the notice to show; null means none is published
 *
 * Business data: every call refuses to run without a current business. Platform's own traffic counts (7.10) never ask this.
 * The shared profile's own consent (9.22) is the platform's, not a business's, and is not here: the shoppers module owns it.
 */
export const CONSENT_PURPOSES = Object.freeze(['fulfilment', 'order_updates', 'marketing', 'analytics_ads']);
export const CONSENT_CHANNELS = Object.freeze(['whatsapp', 'email']);
export const CONSENT_SOURCES = Object.freeze(['sign_in', 'checkout', 'account', 'banner', 'unsubscribe', 'reply', 'seller', 'migration']);
/** Purposes that are asked per channel. */
export const CHANNEL_PURPOSES = Object.freeze(['order_updates', 'marketing']);

export const CONSENT_NOT_ASKED = Object.freeze({ granted: false, answered: false, reason: 'consent.not_built' });

export class ConsentNotReadyError extends Error {
  constructor() {
    super('Shopper consent is not set up: the consent module has not registered its provider');
    this.name = 'ConsentNotReadyError';
    this.code = 'consent.not_built';
  }
}

const PROVIDER_METHODS = Object.freeze(['allows', 'record', 'revoke', 'status', 'notice']);

function checkQuestion({ purpose, channel } = {}) {
  if (!CONSENT_PURPOSES.includes(purpose)) throw new Error(`Unknown consent purpose "${purpose}"`);
  if (CHANNEL_PURPOSES.includes(purpose) ? !CONSENT_CHANNELS.includes(channel) : channel !== undefined && channel !== '') {
    throw new Error(CHANNEL_PURPOSES.includes(purpose) ? `Consent for ${purpose} is asked per channel: whatsapp or email` : `Consent for ${purpose} has no channel`);
  }
}

const hasSubject = (s) => Boolean(s && (s.shopperId || s.phone || s.email || s.visitorId));

export function createConsent() {
  let provider = null;
  const need = () => {
    tenantId();
    if (!provider) throw new ConsentNotReadyError();
    return provider;
  };

  return {
    /** True once the consent module has registered. The console shows tags as not ready until then. */
    get built() {
      return provider !== null;
    },

    /** Called once, by the consent module. `impl` answers allows, record, revoke, status and notice as described above. */
    use(impl) {
      if (provider) throw new Error('A consent provider is already registered');
      for (const method of PROVIDER_METHODS) if (typeof impl?.[method] !== 'function') throw new Error(`A consent provider needs ${method}()`);
      provider = impl;
    },

    async allows(question = {}) {
      tenantId();
      checkQuestion(question);
      if (!provider) return CONSENT_NOT_ASKED;
      if (!hasSubject(question)) return { granted: false, answered: false, reason: 'consent.no_subject' };
      const answer = await provider.allows(question);
      // Anything but a plain yes is a no.
      return { granted: answer?.granted === true, answered: answer?.answered === true, reason: String(answer?.reason ?? (answer?.granted === true ? 'granted' : 'not_granted')) };
    },

    async analyticsAndAds({ visitorId, shopperId } = {}) {
      tenantId();
      if (!provider) return CONSENT_NOT_ASKED;
      return this.allows({ purpose: 'analytics_ads', visitorId, shopperId });
    },

    async record(entry = {}, t) {
      const impl = need();
      if (!hasSubject(entry.subject)) throw new Error('A consent record needs who it is about');
      if (!Array.isArray(entry.choices) || !entry.choices.length) throw new Error('A consent record needs at least one choice');
      for (const choice of entry.choices) {
        checkQuestion(choice);
        if (typeof choice.granted !== 'boolean') throw new Error('Each consent choice is a yes or a no');
      }
      if (!Number.isInteger(entry.noticeVersion) || entry.noticeVersion < 1) throw new Error('A consent record names the notice version that was shown');
      if (!CONSENT_SOURCES.includes(entry.source)) throw new Error(`Unknown consent source "${entry.source}"`);
      return impl.record(entry, t);
    },

    async revoke(entry = {}, t) {
      const impl = need();
      if (!hasSubject(entry.subject)) throw new Error('A consent record needs who it is about');
      checkQuestion(entry);
      if (!CONSENT_SOURCES.includes(entry.source)) throw new Error(`Unknown consent source "${entry.source}"`);
      return impl.revoke(entry, t);
    },

    async status(subject) {
      tenantId();
      if (!provider || !hasSubject(subject)) return [];
      return provider.status(subject);
    },

    async notice() {
      tenantId();
      return provider ? provider.notice() : null;
    },
  };
}
