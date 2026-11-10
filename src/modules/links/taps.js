import crypto from 'node:crypto';
import { COMPLIANCE_LIMITS as L } from '../../contracts/compliance.js';
import { isRowId } from '../admin-api/paging.js';
import { parseTwoTapPayload, render } from '../automations/message.js';
import { directLink } from './rules.js';

const DEFAULT_LINK_MESSAGE = 'Here is the link you asked for.';
const MAX_KEY_PART = 150;

/** A message id as part of an idempotency key: they run long, and a key stops at 200 characters. */
const keyPart = (mid) => (String(mid).length > MAX_KEY_PART ? crypto.createHash('sha256').update(String(mid)).digest('hex').slice(0, 40) : String(mid));

/** Why this automation can't answer a tap, or null. A paused one can: the gate creates the job as held (PRD 4.12, 6.13). */
function blockedBy(automation, tester, at) {
  if (automation.state === 'draft') return 'automation.draft';
  if (automation.state === 'archived') return 'unmapped';
  if (automation.schedule.endsAt && at >= new Date(automation.schedule.endsAt)) return 'paused.automation';
  return automation.state === 'test' && !tester ? 'test_mode' : null;
}

async function firstNameOf(event, { repos, meta }) {
  try {
    const account = event.channel === 'facebook' ? await repos.fbPages?.get(event.accountId) : await repos.igAccounts.get(event.accountId);
    if (!account?.token || !meta?.client) return '';
    const person = await meta.client.forAccount(account).getPerson(event.personId);
    return String(person?.name ?? '').replaceAll('\0', '').trim().split(/\s+/)[0] ?? '';
  } catch {
    return ''; // Meta won't always say (PRD 4.10), and the message reads correctly without it
  }
}

const fitsWithButton = (text) => [...text].length <= L.buttonTextChars && Buffer.byteLength(text) <= L.textBytes;

/** The second message: a button with the direct link (PRD 6.13). The reel's discount code goes in the text when it fits (PRD 6.6). */
async function secondMessage(automation, event, finalUrl, measurementIds, ctx) {
  const template = automation.linkMessage || DEFAULT_LINK_MESSAGE;
  const firstName = template.includes('{first_name}') ? await firstNameOf(event, ctx) : '';
  const text = render(template, { firstName, url: finalUrl });
  const code = measurementIds.find((m) => m.kind === 'discount_code')?.value;
  const withCode = code ? `${text}\nUse code ${code} at checkout.` : text;
  return { text: fitsWithButton(withCode) ? withCode : text, button: { url: finalUrl, title: automation.linkButtonTitle } };
}

/**
 * The second tap of the two-tap flow (PRD 6.13), from messaging_postbacks. The compliance worker has already stored the event, opened the
 * window from the tap and kept out STOPs. The tap is counted before anything else, so a second message that can't go still counts it.
 * Truthy means this event was ours.
 */
export async function onTap(event, ctx) {
  if (event.type !== 'postback') return false;
  const tap = parseTwoTapPayload(event.payload);
  if (!tap) return false;
  const { repos, compliance, config } = ctx;
  const skip = (reason, automationId = null, known = {}) => repos.compliance.record({ channel: event.channel, kind: event.type, subject: event.subject, decision: 'skipped', reason, automationId, ...known });

  const automation = isRowId(tap.automationId) ? await repos.automations.get(tap.automationId) : null;
  const first = automation && await repos.links.firstDm({ channel: event.channel, automationId: automation.id, mediaId: tap.mediaId, commentId: tap.commentId, subject: event.subject });
  if (!first) {
    await skip('unmapped');
    return true;
  }
  const where = { mediaId: tap.mediaId, commentId: tap.commentId };
  const stamped = new Date(event.timestamp ?? event.receivedAt);
  const tappedAt = Number.isNaN(+stamped) ? new Date(event.receivedAt) : stamped;
  const now = new Date((config?.complianceNow ?? Date.now)());
  await repos.links.recordTap({ automationId: automation.id, channel: event.channel, mediaId: tap.mediaId, subject: event.subject, commentId: tap.commentId, variantId: first.variant_id, isTest: first.is_test, at: tappedAt });
  await compliance.cancelFollowups(event.channel, event.subject);

  const tester = await repos.testers.isTester(event.channel, event.subject);
  const blocked = blockedBy(automation, tester, now) ?? (automation.linkUrl ? null : 'unmapped');
  if (blocked) {
    await skip(blocked, automation.id, where);
    return true;
  }

  const settings = await repos.automations.sendSettings();
  const finalUrl = directLink({
    url: automation.linkUrl, linkType: automation.linkType, channel: event.channel, automationSlug: automation.slug, mediaId: tap.mediaId, utmEnabled: settings.utm,
    measurement: await repos.automations.measurement(tap.mediaId),
  });
  const message = await secondMessage(automation, event, finalUrl, await repos.links.idsForMedia(tap.mediaId), ctx);
  await compliance.enqueue({
    kind: 'dm', purpose: 'link', channel: event.channel, accountId: event.accountId, recipientId: event.personId, personId: event.personId, idempotencyKey: `two_tap_link:${keyPart(event.mid)}`,
    expiresAt: new Date(Math.min(+tappedAt, +now) + L.messagingWindowMs), message, automationId: automation.id, mediaId: tap.mediaId,
    ...(first.variant_id ? { variantId: first.variant_id } : {}),
    isTest: Boolean(first.is_test || automation.state === 'test' || automation.dryRun || tester),
  });
  return true;
}
