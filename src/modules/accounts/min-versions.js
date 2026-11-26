import { platformAppHostOf } from '../../config.js';
import { isSignInHost } from '../../tenancy.js';

/** The browser sign-in page's facts (AppRequirements.web): the password form is named only where it can be drawn (P-11). */
function webSignIn(ctx, req) {
  const signInHost = isSignInHost(req?.hostname, platformAppHostOf(ctx.config ?? {}));
  return ctx.config?.passwordLogin && !signInHost ? { signInHost, passwordLogin: true } : { signInHost };
}

/**
 * app.requirements (PRD 10.2, 10.3): what an app must know before anyone signs in. The oldest version the API still
 * answers and where to get a newer one (repos.appVersions; the router answers 426 from the same rows), and which ways
 * of signing in to show. There is never a password field or an SMS option (P-11); Sign in with Apple is offered on iOS
 * (Apple 4.8), once its audiences are set. `web` is what a browser's sign-in page on this address can offer (see the
 * contract): the server knows its own routes, so the page asks nothing else.
 */
export function appRequirements(ctx) {
  return async ({ query, req }) => {
    const minimum = await ctx.repos.appVersions.minimum({ app: query.app, platform: query.platform, tenantId: query.tenantId ?? null });
    const channels = ctx.notify?.channels?.() ?? {};
    return {
      minVersion: minimum?.minVersion ?? '',
      storeUrl: minimum?.storeUrl ?? '',
      signIn: {
        whatsapp: Boolean(channels.whatsapp),
        google: Boolean(ctx.google?.signIn?.configured),
        apple: query.platform === 'ios' && Boolean(ctx.apple?.signIn?.configured),
      },
      web: webSignIn(ctx, req),
    };
  };
}
