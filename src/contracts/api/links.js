import { z } from 'zod';
import { Channel, REASON_CODE_FAMILIES } from '../compliance.js';
import { staffWith } from './access.js';
import { Count, Id, IdParams, IdText, ListQuery, Timestamp, page, required, text } from './common.js';
import { LINK_TYPES, SaveWarning } from './automations.js';

const access = staffWith('automations');

export const MEASUREMENT_KINDS = Object.freeze(['amazon_tag', 'affiliate_sub_id', 'discount_code']);
const LinkReason = z.enum(REASON_CODE_FAMILIES.link);

/** The exact address the shopper will open, with its tags, or why it isn't allowed. Never a Bhava redirect (PRD 4.11). */
export const LinkPreviewBody = z.object({
  url: required(2000, 'Paste the link'),
  automationSlug: text(80).optional(),
  mediaId: text(80).optional(),
  channel: Channel.default('instagram'),
});
export const LinkPreview = z.object({ finalUrl: z.string(), linkType: z.enum(LINK_TYPES), allowed: z.boolean(), reason: LinkReason.nullable(), warnings: z.array(SaveWarning) });

export const LinkCheckBody = z.object({ url: required(2000, 'Paste the link') });
export const LinkCheck = z.object({ ok: z.boolean(), reason: LinkReason.nullable(), httpStatus: z.number().int().nullable(), checkedAt: Timestamp });

export const TapsQuery = ListQuery.extend({ automationId: IdText.optional() });
/** people counts each person once per reel; taps counts every tap (PRD 6.13). */
export const TapSummary = z.object({ automationId: Id, channel: Channel, mediaId: z.string(), people: Count, taps: Count });

export const MeasurementId = z.object({ id: Id, mediaId: z.string(), kind: z.enum(MEASUREMENT_KINDS), network: z.string(), value: z.string(), updatedAt: Timestamp });
export const MeasurementIdSaved = MeasurementId.extend({ warnings: z.array(SaveWarning) });
export const MeasurementIdQuery = ListQuery.extend({ mediaId: text(80).optional() });
export const MeasurementIdCreate = z.object({ mediaId: required(80), kind: z.enum(MEASUREMENT_KINDS), network: text(40).default(''), value: required(120, 'Enter the id') });
export const MeasurementIdUpdate = z.object({ value: required(120, 'Enter the id') });

export const linkRoutes = {
  'links.preview': { method: 'POST', path: '/links/preview', access, body: LinkPreviewBody, response: LinkPreview },
  'links.check': { method: 'POST', path: '/links/check', access, body: LinkCheckBody, response: LinkCheck },
  'links.taps': { method: 'GET', path: '/links/taps', access, query: TapsQuery, response: page(TapSummary) },
  'measurementIds.list': { method: 'GET', path: '/measurement-ids', access, query: MeasurementIdQuery, response: page(MeasurementId) },
  'measurementIds.create': { method: 'POST', path: '/measurement-ids', access, body: MeasurementIdCreate, status: 201, response: MeasurementIdSaved },
  'measurementIds.update': { method: 'PATCH', path: '/measurement-ids/:id', access, params: IdParams, body: MeasurementIdUpdate, response: MeasurementIdSaved },
  'measurementIds.remove': { method: 'DELETE', path: '/measurement-ids/:id', access, params: IdParams, status: 204, response: null },
};
