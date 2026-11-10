import { TRAFFIC_SOURCES } from '../../contracts/analytics.js';

/** Where a session came from, read from its first hit in this order: UTM tags, src, referrer domain, then direct (7.10). Pure. */
const SRC_ALIASES = {
  dm: 'instagram_comment_dm', comment: 'instagram_comment_dm', comment_dm: 'instagram_comment_dm', ig_dm: 'instagram_comment_dm',
  story: 'story_reply', keyword: 'dm_keyword', bio: 'bio_link', linkinbio: 'bio_link', link_in_bio: 'bio_link', profile: 'bio_link',
  fb_dm: 'facebook_dm', fb_comment: 'facebook_comment', fb_post: 'facebook_post', fb_bio: 'facebook_bio', wa: 'whatsapp',
};
const TRIGGER_SOURCES = { comment: 'instagram_comment_dm', story_reply: 'story_reply', story_mention: 'story_mention', dm_keyword: 'dm_keyword', dm_welcome: 'dm_keyword' };

const clean = (value) => String(value ?? '').trim().toLowerCase();

function fromUtm(utm, trigger) {
  const source = clean(utm.source);
  const medium = clean(utm.medium);
  if (!source && !medium) return null;
  if (source === 'instagram' || source === 'ig') {
    if (medium === 'dm') return Object.hasOwn(TRIGGER_SOURCES, trigger) ? TRIGGER_SOURCES[trigger] : 'instagram_comment_dm';
    if (medium === 'story') return 'story_reply';
    if (['bio', 'profile', 'link_in_bio', 'linkinbio', 'social'].includes(medium)) return 'bio_link';
    return 'instagram_comment_dm';
  }
  if (source === 'facebook' || source === 'fb') {
    if (medium === 'dm') return 'facebook_dm';
    if (medium === 'comment') return 'facebook_comment';
    if (medium === 'bio' || medium === 'profile') return 'facebook_bio';
    return 'facebook_post';
  }
  if (source === 'whatsapp' || source === 'wa') return 'whatsapp';
  return 'other_referrer';
}

function fromSrc(src) {
  const value = clean(src);
  if (!value) return null;
  if (TRAFFIC_SOURCES.includes(value)) return value;
  return Object.hasOwn(SRC_ALIASES, value) ? SRC_ALIASES[value] : null;
}

function fromReferrer(domain) {
  if (!domain) return null;
  if (domain === 'instagram.com' || domain.endsWith('.instagram.com')) return 'bio_link';
  if (domain === 'facebook.com' || domain.endsWith('.facebook.com') || domain === 'fb.me') return 'facebook_post';
  if (domain === 'whatsapp.com' || domain.endsWith('.whatsapp.com') || domain === 'wa.me') return 'whatsapp';
  return 'other_referrer';
}

export const sessionSource = ({ utm = {}, src = '', referrerDomain = '', trigger = '' }) =>
  fromUtm(utm, trigger) ?? fromSrc(src) ?? fromReferrer(referrerDomain) ?? 'direct';

/** The referrer's host without "www.", or '' when there is none or it is this same site. Everything else in the address is dropped. */
export function referrerDomainOf(referrer, ownHost) {
  try {
    const host = new URL(String(referrer)).hostname.toLowerCase().replace(/^www\./, '');
    return host === String(ownHost ?? '').toLowerCase().replace(/^www\./, '') ? '' : host;
  } catch {
    return '';
  }
}
