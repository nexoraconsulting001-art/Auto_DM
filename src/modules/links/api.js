import { ApiError } from '../../contracts/api/index.js';
import { currentTenant, tenantId } from '../../tenancy.js';
import { checkerFor, linkContext } from './automation-checks.js';
import { verifyLink } from './check.js';
import { directLink, hostLinkType, hostOf, linkProblem, parseHttps } from './rules.js';

const MEDIA_ID = /^[\w.-]{1,80}$/;
const ID_VALUE = /^[A-Za-z0-9][\w.~-]*$/;
const NETWORK = /^[a-z0-9_-]*$/;
const CHECKS_PER_MINUTE = 30;

const SHARED_ID = Object.freeze({ code: 'shared_measurement_id', message: 'Another live reel uses the same id. Earnings cannot be split by reel.' });

const refuse = (message, field) => new ApiError('validation_failed', message, { fields: { [field]: message } });
const actorOf = (user) => `user:${user.id}`;

/** Letters, digits and a little punctuation, so an id can't reach into the rest of the link it goes on. */
function assertValue(value) {
  if (!ID_VALUE.test(value)) throw refuse('Use only letters, numbers, dots, dashes and underscores.', 'value');
}

/** Answers the links and measurement id routes of the seller API (PRD 4.11, 6.6, 6.13). */
export function linksApi(ctx) {
  const { repos, config, platform } = ctx;
  const clock = () => new Date((config.complianceNow ?? Date.now)());

  const withWarnings = async (saved) => ({ ...saved, warnings: (await repos.links.sharedWithLiveReel(saved)) ? [SHARED_ID] : [] });

  async function isOwnHost(host) {
    const tenant = currentTenant();
    if (tenant?.slug && config.platformDomain && host === `${tenant.slug}.${config.platformDomain}`) return true;
    return (await repos.tenants.getByDomain(host))?.id === tenantId();
  }

  /** The preview isn't told the type, so it reads it from the address and from what the reel has set. */
  async function typeOf(url, measurement) {
    const fromHost = hostLinkType(url);
    if (fromHost) return fromHost;
    const parsed = parseHttps(url);
    if (parsed && await isOwnHost(hostOf(parsed))) return 'bhava_page';
    return measurement.subId ? 'affiliate' : 'seller_site';
  }

  async function sharedWarnings(mediaId) {
    for (const id of await repos.links.idsForMedia(mediaId)) if (await repos.links.sharedWithLiveReel(id)) return [SHARED_ID];
    return [];
  }

  /** A check makes a request to another site, so a business gets only so many. */
  async function takeCheck() {
    const key = `links:checks:${tenantId()}`;
    const used = (await platform.cache.get(key)) ?? 0;
    if (used >= CHECKS_PER_MINUTE) throw new ApiError('rate_limited', 'That’s a lot of link checks. Wait a minute and try again.');
    await platform.cache.set(key, used + 1, 60);
  }

  return {
    async 'links.preview'({ body }) {
      const { url, automationSlug = '', mediaId = '', channel } = body;
      const measurement = mediaId ? await repos.automations.measurement(mediaId) : {};
      const linkType = await typeOf(url, measurement);
      const reason = linkProblem(url, await linkContext(repos));
      if (reason) return { finalUrl: '', linkType, allowed: false, reason, warnings: [] };
      const { utm: utmEnabled } = await repos.automations.sendSettings();
      return {
        finalUrl: directLink({ url, linkType, channel, automationSlug, mediaId, utmEnabled, measurement }),
        linkType, allowed: true, reason: null,
        warnings: mediaId ? await sharedWarnings(mediaId) : [],
      };
    },

    async 'links.check'({ body }) {
      await takeCheck();
      const verdict = await verifyLink(body.url, await linkContext(repos), checkerFor(ctx));
      const checkedAt = clock();
      if (verdict.ok) await repos.links.clearFailedLink(body.url, checkedAt);
      return { ok: verdict.ok, reason: verdict.reason, httpStatus: verdict.httpStatus, checkedAt };
    },

    'links.taps': ({ query }) => repos.links.tapSummaries(query),

    'measurementIds.list': ({ query }) => repos.links.listMeasurementIds(query),

    async 'measurementIds.create'({ body, user }) {
      const { mediaId, kind, value } = body;
      if (!MEDIA_ID.test(mediaId)) throw refuse('That isn’t a reel we can use.', 'mediaId');
      assertValue(value);
      // Only an affiliate sub-ID belongs to a network. The unique key would otherwise let one reel hold two Amazon tags.
      const network = kind === 'affiliate_sub_id' ? body.network.toLowerCase() : '';
      if (!NETWORK.test(network)) throw refuse('Use only letters, numbers, dashes and underscores.', 'network');
      return withWarnings(await repos.links.saveMeasurementId({ mediaId, kind, network, value }, { actor: actorOf(user) }));
    },

    async 'measurementIds.update'({ params, body, user }) {
      assertValue(body.value);
      const saved = await repos.links.updateMeasurementId(params.id, body.value, { actor: actorOf(user) });
      return saved ? withWarnings(saved) : null;
    },

    async 'measurementIds.remove'({ params, user }) {
      if (!(await repos.links.removeMeasurementId(params.id, { actor: actorOf(user) }))) throw new ApiError('not_found');
    },
  };
}
