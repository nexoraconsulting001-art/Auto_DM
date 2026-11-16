/**
 * Signing out of the app on purpose: the push token first, while the session still works, so this phone hears nothing
 * more; then the session on the server, then everything here: SecureStore, and through the services' listener the
 * query cache and every business's saved rows. `reason` is what the sign-in screen says next ('account_deleted' after
 * Delete my account).
 *
 * With no connection it throws and the person stays signed in, so the app never shows "signed out" while the session
 * still works on the server. `requireServer` false is for a session the server has just ended itself (this phone
 * revoked in Settings > Devices, and the lock screen's "Sign in instead").
 *
 * Every way out comes here, the lock screen's "Sign in instead" too, so the 'signedOut' listeners always run. A locked
 * session has no token: its refresh token is read only after an unlock (F-110, P-68), so nothing is sent to the server for
 * it. Everything here is still forgotten, and the next sign-in on this phone registers its push token afresh.
 */
import { SESSION_STATUS, unregisterFromPush } from '@bhava/app-core';

export async function signOutEverywhere({ session, store, reason = 'signed_out', requireServer = true }) {
  if (session.getState().status !== SESSION_STATUS.locked) await unregisterFromPush({ api: session.api, store });
  await session.signOut({ reason, requireServer });
}
