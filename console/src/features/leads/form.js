import { formatDateTime } from '../../lib/format.js';
import { CONSENT_CHANNELS, LEAD_SURFACES } from '../catalog/shared/limits.js';

/**
 * Leads (PRD 8.15): a first name and a phone number or an email, with the shopper's consent per channel against a numbered wording.
 * Only this business's leads are ever here. A download is a file, and each one is written to the audit log.
 */
export const LEAD_TABS = Object.freeze([['/leads', 'Leads'], ['/leads/form', 'Lead form']]);
export const SOURCE_TABS = Object.freeze([['all', 'All'], ['landing', 'Landing pages'], ['creator', 'Creator page'], ['bio', 'Bio link'], ['store', 'Store']]);
export const CONSENT_TABS = Object.freeze([['all', 'Everyone'], ['active', 'May be contacted'], ['withdrawn', 'Consent withdrawn']]);

const SOURCE_TEXT = { landing: 'Landing page', creator: 'Creator page', bio: 'Bio link', store: 'Store' };
export const sourceText = (lead) => [SOURCE_TEXT[lead.source] ?? 'Form', lead.sourceRef && `(${lead.sourceRef})`, lead.utmCampaign && `· ${lead.utmCampaign}`].filter(Boolean).join(' ');

const CHANNEL_TEXT = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', call: 'Phone call' };
export const channelText = (channel) => CHANNEL_TEXT[channel] ?? channel;
export const CHANNEL_CHOICES = Object.freeze(CONSENT_CHANNELS.map((channel) => [channel, channelText(channel)]));

/** Each channel the shopper agreed to, with whether it may still be used. Withdrawn means never again for marketing (K-58). */
export function consentBadges(lead) {
  return lead.consents.map((consent) => (consent.withdrawnAt
    ? { channel: consent.channel, tone: 'bad', text: `${channelText(consent.channel)}: withdrawn`, active: false }
    : { channel: consent.channel, tone: 'good', text: `${channelText(consent.channel)}: agreed`, active: true }));
}

/** The channels that can still be withdrawn. */
export const activeChannels = (lead) => lead.consents.filter((consent) => !consent.withdrawnAt).map((consent) => consent.channel);

/** May this lead be contacted at all? */
export const mayContact = (lead) => activeChannels(lead).length > 0;

export const leadContact = (lead) => [lead.phone, lead.email].filter(Boolean).join(' · ');
export const leadLine = (lead) => `${sourceText(lead)} · ${formatDateTime(lead.createdAt)} · agreed to wording ${lead.consentVersion}`;

// ---- the form's settings -----------------------------------------------------------------------------------------------------

const SURFACE_TEXT = { landing: ['Reel and post pages', 'Under the products of each landing page'], creator: ['Creator page', 'On your bio link page'], store: ['Store', 'On your store’s home page'] };
export const surfaceText = (surface) => SURFACE_TEXT[surface] ?? [surface, ''];

/** Every surface, in a fixed order, with what is saved for it (a surface with nothing saved is off). */
export function formsToRows(settings) {
  const saved = new Map(settings.items.map((item) => [item.surface, item]));
  return LEAD_SURFACES.map((surface) => ({ surface, enabled: saved.get(surface)?.enabled ?? false, offerLine: saved.get(surface)?.offerLine ?? '' }));
}

/** One surface's form as the API takes it (LeadFormUpdate), or why not. */
export function formRowBody(row) {
  const offerLine = row.offerLine.trim();
  if (offerLine.length > 160) return { error: 'Use 160 characters or fewer' };
  if (/[<>{}\0]/.test(offerLine)) return { error: 'Use plain words only' };
  return { body: { surface: row.surface, enabled: row.enabled, offerLine } };
}

/** A new consent wording's channels (ConsentUpdate), in the fixed order, or why not. */
export function consentBody(picked) {
  const channels = CONSENT_CHANNELS.filter((channel) => picked.includes(channel));
  if (!channels.length) return { error: 'Pick at least one way to contact' };
  return { body: { channels } };
}

export const sameChannels = (a, b) => CONSENT_CHANNELS.every((channel) => a.includes(channel) === b.includes(channel));

// ---- downloads ---------------------------------------------------------------------------------------------------------------

export const FORMAT_CHOICES = Object.freeze([['xlsx', 'Excel file'], ['csv', 'CSV file']]);
const DOWNLOAD_STATE = {
  queued: { tone: 'neutral', text: 'Being made' },
  ready: { tone: 'good', text: 'Ready' },
  failed: { tone: 'bad', text: 'Couldn’t be made' },
  expired: { tone: 'neutral', text: 'Expired' },
};

/** A download as its row shows it. The file link is there only while the file is. */
export function downloadView(download) {
  const state = DOWNLOAD_STATE[download.status] ?? DOWNLOAD_STATE.queued;
  const kind = download.format === 'csv' ? 'CSV file' : 'Excel file';
  return {
    ...state,
    title: `${kind} · ${download.rowCount} ${download.rowCount === 1 ? 'lead' : 'leads'}`,
    meta: `Made ${formatDateTime(download.createdAt)}${download.status === 'ready' && download.expiresAt ? ` · kept until ${formatDateTime(download.expiresAt)}` : ''}`,
    href: download.status === 'ready' && download.fileUrl ? download.fileUrl : '',
  };
}
