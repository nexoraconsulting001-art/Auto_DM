import { codesService } from './codes.js';
import { DELETION_JOB, deletionService } from './deletion.js';
import { devicesService } from './devices.js';
import { googleWebRoutes } from './google-web.js';
import { handoffsService } from './handoffs.js';
import { linkHandlers } from './link.js';
import { appRequirements } from './min-versions.js';
import { peopleService } from './people.js';
import { reauthHandlers } from './reauth.js';
import { reviewLoginService } from './review-login.js';
import { sessionOpener } from './session.js';
import { signInHandlers } from './sign-in.js';
import { tokensService } from './tokens.js';

const HOUR = 60 * 60_000;

/**
 * Seller accounts without passwords, and app sessions (PRD 5.11, 10.2, 10.3, 10.6).
 *
 *   src/contracts/accounts.js        the numbers and pure rules: CODE_RULES, AUTH_LIMITS, FRESH_MINUTES, the keyed hashes,
 *                                    sameSecret, PKCE, toE164, isBelowMinimum, reviewCodeProblem
 *   src/contracts/api/auth.js        the routes and their shapes; app.js for app.requirements; provider.js for AUTH_PATHS
 *
 * What is where:
 *
 *   sign-in.js       auth.start, auth.verify (the WhatsApp code), auth.exchange (the end of a browser sign-in), auth.apple,
 *                    auth.refresh
 *   google-web.js    the browser routes in AUTH_PATHS, on PLATFORM_APP_HOST only; web.js is the sign-in page
 *   codes.js         one-time codes: issued, sent through ctx.notify.sendCode, checked, spent
 *   people.js        a person for a verified identity; tying their seller accounts by proof; their first business
 *   session.js       opening a session for a person who just proved who they are, on either transport
 *   tokens.js        refresh families: issuing, rotating, reuse, revoking; dropping push registrations with them
 *   devices.js       auth.devices, auth.revokeDevice, auth.enableDeviceUnlock and the device's re-auth secret
 *   handoffs.js      single-use, PKCE-bound codes carrying a browser sign-in back to the app
 *   reauth.js        auth.reauthStart and auth.reauthVerify
 *   link.js          auth.linkIdentity
 *   deletion.js      auth.deleteAccount and the job that carries a request out
 *   review-login.js  App Review's fixed code
 *   min-versions.js  app.requirements
 *
 * Everything about people, codes, families and devices is about no single business and runs on db.platform. Logs hold
 * ids only: no number, email, code, token or name.
 */
const built = new WeakMap();

/** Every service of this module for one app (ctx), built once. Nothing is read from ctx until a service is used. */
export function accountsFor(ctx) {
  if (built.has(ctx)) return built.get(ctx);
  const people = peopleService(ctx);
  const codes = codesService(ctx);
  const tokens = tokensService(ctx);
  const devices = devicesService(ctx);
  const handoffs = handoffsService(ctx);
  const review = reviewLoginService(ctx, { people });
  const opener = sessionOpener(ctx, { people, tokens, devices });
  const deletion = deletionService(ctx);
  const services = { people, codes, tokens, devices, handoffs, review, opener, deletion };
  built.set(ctx, services);
  return services;
}

export const accounts = {
  name: 'accounts',

  beforeTenant(app, ctx) {
    googleWebRoutes(app, ctx, accountsFor(ctx));
  },

  api(ctx) {
    const services = accountsFor(ctx);
    const signIn = signInHandlers(ctx, services);
    const { sendCode, ...signInRoutes } = signIn;
    const shared = { ...services, sendCode };
    return {
      ...signInRoutes,
      ...reauthHandlers(ctx, shared),
      ...linkHandlers(ctx, shared),
      'auth.devices': (input) => services.devices.list(input),
      'auth.revokeDevice': (input) => services.devices.revoke(input),
      'auth.enableDeviceUnlock': (input) => services.devices.enableUnlock(input),
      'auth.deleteAccount': (input) => services.deletion.request(input),
      'app.requirements': appRequirements(ctx),
    };
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    const services = accountsFor(ctx);
    queue.work(DELETION_JOB, async () => {
      await services.deletion.carryOut();
      await services.codes.purge();
      await services.handoffs.purge();
      await services.tokens.purge();
    });
    return async function schedule() {
      await queue.every(DELETION_JOB, HOUR);
    };
  },
};
