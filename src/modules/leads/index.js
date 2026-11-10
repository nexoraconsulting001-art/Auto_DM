import { notBuilt } from '../not-built.js';

/**
 * PRD 8.15: the lead form on landing pages, the creator page and the store, consent per channel against a numbered wording,
 * withdrawal and downloads (migration 306). A honeypot field and a per-IP rate limit (in the cache, never stored) stop spam;
 * no CAPTCHA. Leads are personal data: never log a name, phone number or email. New-lead alerts go to repos.alerts.
 */
export const leads = {
  name: 'leads',
  api: () => notBuilt(
    'leads.list', 'leads.get', 'leads.remove', 'leads.revokeConsent',
    'leadForms.get', 'leadForms.update', 'leadForms.setConsent',
    'leadDownloads.list', 'leadDownloads.create', 'leadDownloads.get',
  ),
};
