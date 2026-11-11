/**
 * The demo business that App Review signs in to (PRD 10.6: Apple 2.1(a)). One track owns this folder and edits nothing
 * outside it. It has no routes of its own: it is an ordinary business, made and kept by this module, that the review
 * login (src/modules/accounts) opens.
 *
 * Rules the tests will hold this folder to:
 *
 * - One structure for every client: the demo business is rows, never a branch in code. Nothing outside this folder
 *   may ask "is this the demo business?", and `npm run policy-check` still passes.
 * - `ensure()` makes the business if it is missing and fills it with sample orders, analytics and automations, so the
 *   review login opens something to look at (P-24). Running it again changes nothing that is already there.
 * - Its Instagram connection is never live. Screens that read Instagram show the stored sample data, not an error
 *   (P-25), through the same cache tables every business reads (migrations 200 to 206): nothing calls Meta for it.
 * - It never sends: no DM, no WhatsApp, no email leaves for a sample shopper. Its sample people are made up and hold
 *   no real number.
 * - The review login is the only way in, and it never expires; `review_logins.tenant_id` names this business.
 */
export const demoTenant = {
  name: 'demo-tenant',
};
