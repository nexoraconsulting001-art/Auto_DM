import { z } from 'zod';
import { LEAD_SURFACES } from '../buyer-pages.js';
import { MANAGERS, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, Timestamp, page, text } from './common.js';

/**
 * The lead form (PRD 8.15), answered by src/modules/leads: a first name and a phone number or an email, with consent given per
 * channel against a numbered wording that names the seller. Only this business's leads, ever: they are never moved between
 * businesses and outside lists can't be imported. A download is a file (no route may be named "export") and every one is
 * written to the audit log. On tier 1 the form is an add-on (lead_form through tenant_features); without it the settings say
 * available: false and the form's address is the branded 404 (K-59).
 */
const reader = staffWith('customers');

export const CONSENT_CHANNELS = Object.freeze(['whatsapp', 'sms', 'email', 'call']);

export const Lead = z.object({
  id: Id,
  firstName: z.string(),
  phone: z.string(), // international format, +<country><number>
  email: z.string(),
  source: z.enum(['landing', 'creator', 'store', 'bio']),
  sourceRef: z.string(),
  utmCampaign: z.string(),
  pageId: Id.nullable(),
  consentVersion: z.number().int().min(1),
  consentedAt: Timestamp,
  /** Per channel; withdrawnAt set means never use it for marketing again (K-58). */
  consents: z.array(z.object({ channel: z.enum(CONSENT_CHANNELS), grantedAt: Timestamp, withdrawnAt: Timestamp.nullable() })),
  createdAt: Timestamp,
});
export const LeadListQuery = ListQuery.extend({
  source: z.enum(['all', 'landing', 'creator', 'store', 'bio']).default('all'),
  consent: z.enum(['all', 'active', 'withdrawn']).default('all'),
});
export const LeadConsentRevoke = z.object({ channels: z.array(z.enum(CONSENT_CHANNELS)).min(1).max(4).optional() });

export const ConsentText = z.object({ version: z.number().int().min(1), body: z.string(), channels: z.array(z.enum(CONSENT_CHANNELS)) });
export const LeadFormSetting = z.object({ surface: z.enum(LEAD_SURFACES), enabled: z.boolean(), offerLine: z.string() });
export const LeadForms = z.object({ available: z.boolean(), consent: ConsentText.nullable(), items: z.array(LeadFormSetting) });
export const LeadFormUpdate = z.object({ surface: z.enum(LEAD_SURFACES), enabled: z.boolean().optional(), offerLine: text(160).optional() });
/** A new consent wording, made from the business's name and these channels. The old versions stay, unchanged. */
export const ConsentUpdate = z.object({ channels: z.array(z.enum(CONSENT_CHANNELS)).min(1, 'Pick at least one way to contact').max(4) });

export const LeadDownload = z.object({
  id: Id,
  format: z.enum(['csv', 'xlsx']),
  status: z.enum(['queued', 'ready', 'failed', 'expired']),
  rowCount: Count,
  fileUrl: z.string().nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
});
export const LeadDownloadCreate = z.object({ format: z.enum(['csv', 'xlsx']).default('xlsx') });

export const leadRoutes = {
  'leads.list': { method: 'GET', path: '/leads', access: reader, query: LeadListQuery, response: page(Lead) },
  'leads.get': { method: 'GET', path: '/leads/:id', access: reader, params: IdParams, response: Lead },
  /** Deletes the lead and its consent records (9.18). */
  'leads.remove': { method: 'DELETE', path: '/leads/:id', access: MANAGERS, params: IdParams, status: 204, response: null },
  /** Records a consent withdrawal the shopper sent some other way; all channels when none are named. (Not named "withdraw": no seller route may contain "raw".) */
  'leads.revokeConsent': { method: 'POST', path: '/leads/:id/revoke-consent', access: reader, params: IdParams, body: LeadConsentRevoke, response: Lead },
  'leadForms.get': { method: 'GET', path: '/lead-forms', access: MANAGERS, response: LeadForms },
  'leadForms.update': { feature: 'lead_form', method: 'PATCH', path: '/lead-forms', access: MANAGERS, body: LeadFormUpdate, response: LeadForms },
  'leadForms.setConsent': { feature: 'lead_form', method: 'PUT', path: '/lead-forms/consent', access: MANAGERS, body: ConsentUpdate, response: LeadForms },
  'leadDownloads.list': { method: 'GET', path: '/lead-downloads', access: MANAGERS, query: ListQuery, response: page(LeadDownload) },
  'leadDownloads.create': { method: 'POST', path: '/lead-downloads', access: MANAGERS, body: LeadDownloadCreate, status: 201, response: LeadDownload },
  'leadDownloads.get': { method: 'GET', path: '/lead-downloads/:id', access: MANAGERS, params: IdParams, response: LeadDownload },
};
