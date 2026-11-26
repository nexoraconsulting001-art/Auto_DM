import { z } from 'zod';
import { APPS, APP_PLATFORMS } from '../accounts.js';
import { PUBLIC } from './access.js';
import { Id } from './common.js';

/**
 * What an app must know before anyone signs in (PRD 10.2, 10.3): the oldest version the API still answers, where to
 * get a newer one, and which ways of signing in to show. Public, on PLATFORM_APP_HOST, and never refused for being
 * too old itself. The work is in src/modules/accounts (minimum versions).
 *
 * Every request from an app carries X-App (owner or shopper), X-App-Version and X-App-Platform (APP_HEADERS in
 * src/contracts/accounts.js). Below the minimum, any other route answers 426 with code `update_required` and `storeUrl`.
 */
export const AppRequirementsQuery = z.object({
  app: z.enum(APPS).default('owner'),
  platform: z.enum(APP_PLATFORMS),
  /** The shopper app's business. The owner app has none. */
  tenantId: z.coerce.number().pipe(Id).optional(),
});

export const AppRequirements = z.object({
  /** Empty when no minimum is set. */
  minVersion: z.string(),
  storeUrl: z.string(),
  /** Which buttons the sign-in screen shows. There is never a password field or an SMS option (P-11). */
  signIn: z.object({ whatsapp: z.boolean(), google: z.boolean(), apple: z.boolean() }),
  /**
   * What a sign-in page in a browser on the address this was asked from can offer, so it never asks a route that may not
   * be there (each such miss is a 404 the browser reports as an error):
   *   signInHost     this is the sign-in host (PLATFORM_APP_HOST), the only address where Google's browser sign-in
   *                  (AUTH_PATHS.googleStart) exists, and where no password could name a business.
   *   passwordLogin  the phone-and-password route exists (PASSWORD_LOGIN: tests and local runs only; production refuses
   *                  to start with it). It says nothing about any account, and the route answers the same either way.
   * The apps ignore it: they start Google through their own redirect, and never show a password field.
   */
  web: z.object({ signInHost: z.boolean(), passwordLogin: z.boolean() }),
});

export const appRoutes = {
  'app.requirements': { method: 'GET', path: '/app/requirements', access: PUBLIC, noBusiness: true, query: AppRequirementsQuery, response: AppRequirements },
};
