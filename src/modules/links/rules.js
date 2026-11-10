/**
 * Direct links (PRD 4.11, 6.6). Owned by the links track; automations and compliance import these two functions from here.
 * Stubs until that track fills them in.
 */

/**
 * The exact address the shopper will open: the destination with its tags, never a Bhava hop.
 * link: { url, linkType, channel, automationSlug, mediaId, variantLabel, utmEnabled, measurement: { amazonTag?, subId?, subIdParam? } }
 */
export function directLink(link) {
  return link.url;
}

/**
 * Why this destination can't be used, as a reason code, or null when it can.
 * context: { whatsappNumber, blockedHosts }, with blockedHosts as a Map of host to category from link_blocked_hosts.
 */
export function linkProblem() {
  return null;
}
