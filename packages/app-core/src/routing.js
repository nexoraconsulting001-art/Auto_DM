/**
 * Where a tapped push or an opened link takes the person (PRD 10.3, 10.5; P-13, P-20). No native module here, so the
 * rules are tested on their own.
 *
 *   const router = createLinkRouter({ session });
 *   const detach = router.attach(navigate, tenantId);   // the navigation for that business, once it is ready
 *   router.openPush(response);                          // a tapped notification
 *   router.openUrl('bhavabusiness://orders/12');       // a link from an email or another app
 *
 * The rules it keeps:
 *   - A target in another of the person's businesses switches to that business first, and the record opens only in
 *     the navigation of that business, once it has mounted. The old business's screens never draw it.
 *   - A business the person does not belong to opens nothing, and nothing is switched.
 *   - Before sign-in or while locked, the target waits; it opens after the unlock or sign-in, or is dropped at sign-out.
 *   - The same tapped notification is opened once, however often the system hands it back (the one that launched
 *     the app comes back every time the listener is set up).
 *   - Targets are handled one after another, in the order they came: two quick taps never race two switches.
 */
import { isLinkPath, parseLink, OWNER_APP_SCHEME } from './links.js';

/** Where a tapped push leads: { tenantId, path }, or null for one that names no record. */
export function pushTarget(response) {
  const content = response?.notification?.request?.content;
  const data = content?.data ?? response?.notification?.request?.trigger?.remoteMessage?.data ?? response?.data ?? {};
  const tenantId = Number(data.tenantId);
  const path = typeof data.link === 'string' ? data.link : '';
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !isLinkPath(path)) return null;
  return { tenantId, path };
}

/** What makes one tapped notification itself: its identifier, or failing that its date and link. */
export function tapId(response) {
  const request = response?.notification?.request;
  if (typeof request?.identifier === 'string' && request.identifier) return `id:${request.identifier}:${response.actionIdentifier ?? ''}`;
  const date = response?.notification?.date;
  const link = request?.content?.data?.link;
  return date && link ? `at:${date}:${link}` : null;
}

export function createLinkRouter({ session, schemes = [OWNER_APP_SCHEME], remember = 200 } = {}) {
  if (!session) throw new Error('createLinkRouter needs the session');
  let navigator = null; // { navigate, tenantId }
  let pending = null; // { tenantId, path } waiting for its business's navigation
  let waiting = null; // a target that came while signed out or locked
  let chain = Promise.resolve();
  const seen = [];

  const ready = () => {
    const state = session.getState();
    return state.status === 'signedIn' && Boolean(state.user);
  };

  function flush() {
    if (!pending || !navigator || !ready()) return false;
    const state = session.getState();
    if (navigator.tenantId !== pending.tenantId || state.tenantId !== pending.tenantId) return false;
    const { path } = pending;
    pending = null;
    navigator.navigate(path);
    return true;
  }

  async function go(target) {
    const state = session.getState();
    if (state.status !== 'signedIn') {
      if (state.status === 'signedOut') return 'signed_out';
      waiting = target; // locked or still starting: after the unlock
      return 'waiting';
    }
    const tenantId = target.tenantId ?? state.tenantId;
    if (tenantId !== state.tenantId) {
      if (!state.businesses.some((business) => business.id === tenantId)) return 'not_member';
      pending = null; // a newer target replaces one that had not opened yet
      await session.switchBusiness(tenantId);
    }
    pending = { tenantId, path: target.path };
    return flush() ? 'opened' : 'pending';
  }

  function open(target) {
    if (!target || !isLinkPath(target.path)) return Promise.resolve('ignored');
    const run = chain.then(() => go(target)).catch(() => 'failed');
    chain = run;
    return run;
  }

  session.subscribe((state) => {
    if (state.status === 'signedOut') {
      pending = null;
      waiting = null;
      return;
    }
    if (waiting && state.status === 'signedIn' && state.user) {
      const target = waiting;
      waiting = null;
      open(target);
      return;
    }
    flush();
  });

  return {
    open,
    /** A link from outside: the app's own scheme only. The end of a browser sign-in is not a screen and is ignored here. */
    openUrl(url) {
      const link = parseLink(url, { schemes });
      if (link?.kind !== 'screen') return Promise.resolve('ignored');
      return open({ tenantId: link.tenantId, path: link.path });
    },
    /** A tapped notification. The same one handed back again opens nothing more. */
    openPush(response) {
      const id = tapId(response);
      if (id) {
        if (seen.includes(id)) return Promise.resolve('repeat');
        seen.push(id);
        if (seen.length > remember) seen.shift();
      }
      return open(pushTarget(response));
    },
    /** The navigation of one business is ready. Returns the way to let go (when it unmounts). */
    attach(navigate, tenantId) {
      const mine = { navigate, tenantId: Number(tenantId) };
      navigator = mine;
      flush();
      return () => {
        if (navigator === mine) navigator = null;
      };
    },
    /** What is waiting to open, for a test. */
    pending: () => pending ?? waiting,
  };
}
