/**
 * What the user agent says, read once at ingest and then dropped (7.10). Only these derived values are kept.
 * Pure, so the rules can be tested and changed in one place.
 */
const LINK_PREVIEW = /facebookexternalhit|facebot|whatsapp\/|telegrambot|twitterbot|linkedinbot|slackbot|slack-imgproxy|discordbot|skypeuripreview|pinterestbot|pinterest\/|vkshare|redditbot|embedly|iframely|quora link preview|bitlybot|snapchat.*preview/i;
// A bare "bot" must stand alone or end a product name before a slash, so a phone called CUBOT is still a person.
const BOT = /(?:^|[^a-z])(?:bot|crawler|spider)(?:[^a-z]|$)|[a-z]bot\/|crawl|spider|slurp|mediapartners|adsbot|apis-google|google-inspectiontool|googleother|bingpreview|lighthouse|pagespeed|headlesschrome|phantomjs|scrapy|python-requests|curl\/|wget\/|libwww|ahrefs|semrush|mj12|petalbot|bytespider|gptbot|claudebot|ccbot|amazonbot|applebot|yandex|baiduspider/i;

/** 'crawler' for a link preview, 'bot' for any other automated visitor, or null for a person. */
export function automatedKind(ua) {
  const agent = String(ua ?? '');
  if (LINK_PREVIEW.test(agent)) return 'crawler';
  return BOT.test(agent) ? 'bot' : null;
}

export function inAppBrowser(ua) {
  const agent = String(ua ?? '');
  if (/instagram/i.test(agent)) return 'instagram';
  if (/fban|fbav|fb_iab|fbios/i.test(agent)) return 'facebook';
  if (/snapchat|linkedinapp|line\/|musical_ly|bytedancewebview|tiktok|pinterest|; wv\)/i.test(agent)) return 'other_in_app';
  return 'browser';
}

export function deviceType(ua) {
  const agent = String(ua ?? '');
  if (/ipad|tablet|playbook|silk|kindle/i.test(agent) || (/android/i.test(agent) && !/mobile/i.test(agent))) return 'tablet';
  if (/mobi|iphone|ipod|windows phone/i.test(agent)) return 'mobile';
  if (/windows nt|macintosh|x11|cros|linux x86/i.test(agent)) return 'desktop';
  return 'other';
}

export function operatingSystem(ua) {
  const agent = String(ua ?? '');
  if (/android/i.test(agent)) return 'Android';
  if (/iphone|ipad|ipod|cpu os/i.test(agent)) return 'iOS';
  if (/windows/i.test(agent)) return 'Windows';
  if (/macintosh|mac os x/i.test(agent)) return 'macOS';
  if (/cros/i.test(agent)) return 'ChromeOS';
  if (/linux/i.test(agent)) return 'Linux';
  return 'Other';
}

export function browserName(ua) {
  const agent = String(ua ?? '');
  if (inAppBrowser(agent) !== 'browser') return 'In-app';
  if (/edg\//i.test(agent)) return 'Edge';
  if (/opr\/|opera/i.test(agent)) return 'Opera';
  if (/samsungbrowser/i.test(agent)) return 'Samsung Internet';
  if (/ucbrowser/i.test(agent)) return 'UC Browser';
  if (/firefox|fxios/i.test(agent)) return 'Firefox';
  if (/chrome|crios/i.test(agent)) return 'Chrome';
  if (/safari/i.test(agent)) return 'Safari';
  return 'Other';
}

export const describeAgent = (ua) => ({ device: deviceType(ua), os: operatingSystem(ua), browser: browserName(ua), in_app: inAppBrowser(ua) });
