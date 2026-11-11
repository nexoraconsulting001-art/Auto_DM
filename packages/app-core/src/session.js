/**
 * One signed-in session for an app (PRD 10.2, 10.3): the API client, the tokens behind it and the business in use.
 *
 *   const session = createSession({ baseUrl, app: { name: 'owner', version, platform }, store });
 *   await session.start();                       // signedOut, locked (ask for fingerprint first) or signedIn
 *   await session.adopt(await session.api.auth.verify({ phone, code, device: await session.device() }));
 *   const { items } = await session.api.orders.list();
 *
 * The rules it keeps:
 *   - The access token is held in memory only. The refresh token is in SecureStore and nowhere else.
 *   - A 401 on any call is answered with one silent refresh and one retry of that call (P-04). Calls that arrive
 *     while a refresh is running wait for it, so a refresh token is never presented twice (that would end the family).
 *   - The new refresh token is stored before the new access token is used.
 *   - A refresh the server refuses signs the person out here: a revoked device or a removed account stops on its
 *     next call (P-08). A refresh that could not reach the server changes nothing: the app stays as it is, offline.
 *   - Switching business tells every listener, so the caller can drop what it cached for the old one (P-10).
 *   - 426 `update_required` and 403 `reauth_required` are reported, not handled here.
 */
import { createApiClient } from '@bhava/api-client';

const NO_REFRESH = /\/auth\/(refresh|start|verify|exchange|apple|login)(\?|$)/;
const REFRESH_EARLY_MS = 20_000;

export const SESSION_STATUS = Object.freeze({ loading: 'loading', signedOut: 'signedOut', locked: 'locked', signedIn: 'signedIn' });

export function createSession({ baseUrl, app, store, fetch: rawFetch = (...args) => globalThis.fetch(...args), now = () => Date.now(), deviceName = '' } = {}) {
  if (!/^https?:\/\//.test(baseUrl ?? '')) throw new Error('createSession needs the API address, such as https://app.example/api/v1');
  if (!store) throw new Error('createSession needs a secure store');

  let state = Object.freeze({ status: SESSION_STATUS.loading, user: null, business: null, businesses: [], tenantId: null, freshUntil: null, updateRequired: null, offline: false, signedOutReason: null });
  let accessToken = null;
  let accessExpiresAt = 0;
  let refreshing = null;
  const listeners = new Set();
  const handlers = { switch: new Set(), signedOut: new Set(), reauth: new Set() };

  function set(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener(state);
  }
  const emit = (event, value) => {
    for (const handler of [...handlers[event]]) handler(value);
  };

  const updateRequired = (error) => set({ updateRequired: { storeUrl: error.storeUrl ?? '' } });
  /** A client with no token, for the refresh itself. */
  const bare = createApiClient({ baseUrl, app, fetch: rawFetch, onUpdateRequired: updateRequired });

  async function forget(reason) {
    accessToken = null;
    accessExpiresAt = 0;
    await store.clearSession();
    set({ status: SESSION_STATUS.signedOut, user: null, business: null, businesses: [], tenantId: null, freshUntil: null, offline: false, signedOutReason: reason });
    emit('signedOut', reason);
  }

  /** True when a new access token is in hand; false when the server refused (and the session is gone); throws when the server was not reached. */
  function refresh() {
    refreshing ??= (async () => {
      const refreshToken = await store.getRefreshToken();
      if (!refreshToken) {
        if (state.status !== SESSION_STATUS.signedOut) await forget('expired');
        return false;
      }
      let answer;
      try {
        answer = await bare.auth.refresh({ refreshToken });
      } catch (error) {
        if (error.status === 0 || error.status >= 500 || error.code === 'update_required') throw error;
        await forget('expired');
        return false;
      }
      await store.setRefreshToken(answer.refreshToken); // before the access token is used: a crash here must not lose the family
      accessToken = answer.accessToken;
      accessExpiresAt = now() + answer.accessExpiresInSeconds * 1000;
      return true;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function getToken() {
    if (refreshing) await refreshing.catch(() => {});
    if (accessToken && now() > accessExpiresAt - REFRESH_EARLY_MS) await refresh().catch(() => {});
    return accessToken;
  }

  /** fetch, with one silent refresh and one retry after a 401. */
  async function send(url, init = {}) {
    const response = await rawFetch(url, init);
    if (response.status !== 401 || NO_REFRESH.test(String(url)) || !init.headers?.authorization) return response;
    const sent = init.headers.authorization;
    // Another call may have refreshed while this one was in the air: then the token in hand is already newer.
    const renewed = accessToken && sent !== `Bearer ${accessToken}` ? true : await refresh().catch(() => false);
    if (!renewed || !accessToken) return response;
    return rawFetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${accessToken}` } });
  }

  const api = createApiClient({
    baseUrl,
    app,
    fetch: send,
    getToken,
    getTenantId: () => state.tenantId,
    onUpdateRequired: updateRequired,
    onReauthRequired: (error) => emit('reauth', error),
  });

  const snapshotOf = ({ user, business, businesses }) => ({ user: user && { id: user.id, name: user.name, role: user.role, permissions: user.permissions ?? [] }, business, businesses });

  async function load({ tenantId } = {}) {
    if (tenantId) set({ tenantId });
    const [me, list] = await Promise.all([api.auth.me(), api.auth.businesses()]);
    const next = { status: SESSION_STATUS.signedIn, user: me.user, business: me.business, businesses: list.businesses, tenantId: me.business.id, freshUntil: me.freshUntil ?? null, offline: false, signedOutReason: null };
    set(next);
    await store.setTenantId(me.business.id);
    await store.setSnapshot(snapshotOf(next));
  }

  /** Opens the stored session: refresh, then who and where. Offline, it opens on what was known last. */
  async function resume() {
    const tenantId = await store.getTenantId();
    try {
      if (!(await refresh())) return state;
      await load({ tenantId });
    } catch (error) {
      if (error.code === 'update_required') return state;
      if (error.status === 401) {
        if (state.status !== SESSION_STATUS.signedOut) await forget('expired');
        return state;
      }
      const snapshot = await store.getSnapshot();
      if (!snapshot?.user || !snapshot?.business) throw error;
      set({ status: SESSION_STATUS.signedIn, ...snapshot, tenantId: tenantId ?? snapshot.business.id, offline: true });
    }
    return state;
  }

  return {
    api,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** `event`: 'switch' (the new business id), 'signedOut' (why) or 'reauth' (the refused call's error). Returns the way to stop. */
    on(event, handler) {
      handlers[event].add(handler);
      return () => handlers[event].delete(handler);
    },

    /** What sign-in routes take as `device`. */
    async device() {
      return { id: await store.getDeviceId(), name: String(deviceName).slice(0, 80), platform: app.platform, app: app.name, appVersion: app.version };
    },

    /** At launch. With the lock on, the refresh token stays where it is until `resume()` is called after an unlock. */
    async start() {
      if (!(await store.getRefreshToken())) {
        set({ status: SESSION_STATUS.signedOut });
        return state;
      }
      if (await store.isLockEnabled()) {
        const snapshot = await store.getSnapshot();
        set({ status: SESSION_STATUS.locked, business: snapshot?.business ?? null });
        return state;
      }
      return resume();
    },
    resume,

    /** Takes the answer of auth.verify, auth.exchange or auth.apple (an AuthSession for transport "bearer"). */
    async adopt(authSession) {
      if (!authSession?.accessToken || !authSession?.refreshToken) throw new Error('This sign-in answer holds no tokens');
      await store.setRefreshToken(authSession.refreshToken);
      accessToken = authSession.accessToken;
      accessExpiresAt = now() + (authSession.accessExpiresInSeconds ?? 0) * 1000;
      const next = {
        status: SESSION_STATUS.signedIn, user: authSession.user, business: authSession.business, businesses: authSession.businesses ?? [],
        tenantId: authSession.business.id, freshUntil: authSession.freshUntil ?? null, offline: false, signedOutReason: null,
      };
      set(next);
      await store.setTenantId(authSession.business.id);
      await store.setSnapshot(snapshotOf(next));
      return state;
    },

    /** Works in another of the person's businesses. Listeners hear first, so nothing of the old business is still on screen when the new one loads. */
    async switchBusiness(tenantId) {
      const id = Number(tenantId);
      if (id === state.tenantId) return state;
      if (!state.businesses.some((business) => business.id === id)) throw new Error('That business is not one of yours');
      const before = { tenantId: state.tenantId, user: state.user, business: state.business };
      emit('switch', id);
      set({ tenantId: id, user: null, business: null });
      try {
        await load();
      } catch (error) {
        emit('switch', before.tenantId);
        set(before);
        throw error;
      }
      return state;
    },

    /** Marks a re-auth that just succeeded, so the caller can repeat the refused request. */
    setFresh: (freshUntil) => set({ freshUntil }),
    refreshUser: () => load(),

    async signOut() {
      if (accessToken) await api.auth.logout().catch(() => {});
      await forget('signed_out');
    },
  };
}
