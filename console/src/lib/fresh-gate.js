/**
 * The console's one way to ask "Confirm it’s you" (PRD 5.11). Every route the contract marks `fresh` answers 403
 * `reauth_required` once the last sign-in or re-auth is a few minutes old. The console's API client (lib/api) hands that
 * refusal here, the re-auth sheet that FreshProvider mounts once for the whole signed-in console opens, and the client
 * repeats the call when it is confirmed. So no screen has to remember to ask: any fresh call from any page is covered.
 *
 * This file is plain JS (no React) so the client can import it without a cycle and tests can drive it.
 */

/** What a caller gets when the person closes the re-auth sheet: nothing to report. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

export const isCancelled = (error) => Boolean(error?.cancelled);

let opener = null;

/**
 * FreshProvider registers how to ask: a function that opens the sheet and resolves once the session is fresh again, or
 * rejects with Cancelled. Returns the function that unregisters it.
 */
export function setFreshOpener(open) {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/**
 * Asks the person to confirm it is them. Resolves true when the session is fresh again, rejects with Cancelled when they
 * close the sheet, and resolves false when no sheet is mounted (signed out), so the refusal stands.
 */
export async function confirmFresh() {
  if (!opener) return false;
  await opener();
  return true;
}
