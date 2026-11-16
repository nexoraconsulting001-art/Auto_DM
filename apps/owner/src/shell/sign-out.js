/**
 * Signing out of the app on purpose: the push token first, while the session still works, so this phone hears nothing
 * more; then the session on the server, then everything here: SecureStore, and through the services' listener the
 * query cache and every business's saved rows. `reason` is what the sign-in screen says next ('account_deleted' after
 * Delete my account).
 *
 * With no connection it throws and the person stays signed in, so the app never shows "signed out" while the session
 * still works on the server. `requireServer` false is for a session the server has just ended itself (this phone
 * revoked in Settings > Devices, or "Sign in instead" on the lock screen, which must never be stuck behind the lock).
 *
 * Every way out of a session comes here, the lock screen's "Sign in instead" too: a locked session's refresh token is
 * presented once (session.releaseForSignOut) so the server ends it and this phone stops hearing pushes.
 */
import { unregisterFromPush } from '@bhava/app-core';

export async function signOutEverywhere({ session, store, reason = 'signed_out', requireServer = true }) {
  await session.releaseForSignOut({ requireServer }); // from the lock screen: only so the server hears this sign-out
  await unregisterFromPush({ api: session.api, store });
  await session.signOut({ reason, requireServer });
}
