/**
 * The client for the seller API at /api/v1, written by hand from src/contracts/api and kept in step with it
 * by a test. No dependencies, so the web console and the owner app can both use it.
 *
 *   const api = createApiClient();                                                  // web console: same site, cookie session
 *   const api = createApiClient({ baseUrl: 'https://shop.example/api/v1', getToken });   // owner app: bearer token
 *
 *   const { items, nextCursor } = await api.products.list({ search: 'pot', limit: 20 });
 *   await api.products.update(12, { active: false });
 *
 * A method that names one thing takes its id first, then its input. Every failure is thrown as an ApiError.
 */
export class ApiError extends Error {
  /** `status` is 0 when the server could not be reached; `code` is from the API's error format. */
  constructor({ status, code, message, fields, reason, requestId }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields ?? {};
    this.reason = reason;
    this.requestId = requestId;
  }
}

const SERVER_FAULT = 'Something went wrong on our side. Please try again.';
const id = (value) => encodeURIComponent(String(value));

function withQuery(path, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

async function toError(response) {
  const body = await response.json().catch(() => null);
  return new ApiError({
    status: response.status,
    code: body?.code ?? 'internal',
    message: body?.error ?? SERVER_FAULT,
    fields: body?.fields,
    reason: body?.reason,
    requestId: body?.requestId,
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] where /api/v1 is; defaults to this site
 * @param {() => (string|null|Promise<string|null>)} [options.getToken] the bearer token, when not using a cookie session
 * @param {(error: ApiError) => void} [options.onUnauthorized] called on any 401
 * @param {typeof fetch} [options.fetch] replaces the global fetch
 */
export function createApiClient({ baseUrl = '/api/v1', getToken, onUnauthorized, fetch: send = (...args) => globalThis.fetch(...args) } = {}) {
  let csrf = ''; // the cookie session's token, learned from auth.login and auth.me

  async function request(method, path, { json, form } = {}) {
    const headers = { accept: 'application/json' };
    const token = await getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (json !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await send(`${baseUrl}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        ...(json !== undefined ? { body: JSON.stringify(json) } : form ? { body: form } : {}),
      });
    } catch {
      throw new ApiError({ status: 0, code: 'network', message: 'We couldn’t reach the server. Check your connection and try again.' });
    }
    if (!response.ok) {
      const error = await toError(response);
      if (response.status === 401) onUnauthorized?.(error);
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  const get = (path, query) => request('GET', withQuery(path, query));
  const post = (path, json) => request('POST', path, { json });
  const put = (path, json) => request('PUT', path, { json });
  const patch = (path, json) => request('PATCH', path, { json });
  const del = (path) => request('DELETE', path);
  const rememberCsrf = (session) => {
    csrf = session.csrf ?? '';
    return session;
  };

  return {
    auth: {
      /** @param body { phone, password, transport?: 'bearer' | 'cookie' } @returns LoginResult */
      login: (body) => post('/auth/login', body).then(rememberCsrf),
      /** @returns CurrentSession { user, business, csrf? } */
      me: () => get('/auth/me').then(rememberCsrf),
      logout: () => post('/auth/logout').finally(() => { csrf = ''; }),
      /** @returns { businesses: [{ id, slug, name, role, logoUrl, current }] }: send an id as X-Tenant-Id to work in it */
      businesses: () => get('/auth/businesses'),
    },
    products: {
      /** @param query { search?, status?, category?, cursor?, limit? } */
      list: (query) => get('/products', query),
      create: (body) => post('/products', body),
      get: (productId) => get(`/products/${id(productId)}`),
      update: (productId, body) => patch(`/products/${id(productId)}`, body),
      remove: (productId) => del(`/products/${id(productId)}`),
    },
    categories: {
      list: (query) => get('/categories', query),
      create: (body) => post('/categories', body),
      get: (categoryId) => get(`/categories/${id(categoryId)}`),
      update: (categoryId, body) => patch(`/categories/${id(categoryId)}`, body),
      remove: (categoryId) => del(`/categories/${id(categoryId)}`),
    },
    reels: {
      list: (query) => get('/reels', query),
      get: (reelId) => get(`/reels/${id(reelId)}`),
      /** Creates the reel's store the first time and replaces it after that. */
      save: (reelId, body) => put(`/reels/${id(reelId)}`, body),
      remove: (reelId) => del(`/reels/${id(reelId)}`),
      instagramPosts: (query) => get('/instagram/posts', query),
    },
    orders: {
      /** @param query { status?, search?, cursor?, limit? } */
      list: (query) => get('/orders', query),
      get: (orderId) => get(`/orders/${id(orderId)}`),
      /** @param body { status, notes? } */
      setStatus: (orderId, body) => post(`/orders/${id(orderId)}/status`, body),
    },
    customers: {
      /** @param query { search?, cursor?, limit? } */
      list: (query) => get('/customers', query),
      /** @returns { temporaryPassword }, shown once */
      resetPassword: (customerId) => post(`/customers/${id(customerId)}/reset-password`),
    },
    settings: {
      get: () => get('/settings'),
      update: (body) => patch('/settings', body),
      updatePayment: (body) => patch('/settings/payment', body),
      setup: () => get('/settings/setup'),
    },
    brandKit: {
      get: () => get('/brand-kit'),
      update: (body) => patch('/brand-kit', body),
      presets: () => get('/brand-kit/presets'),
    },
    activity: {
      list: (query) => get('/activity', query),
    },
    audit: {
      list: (query) => get('/audit-log', query),
    },
    stats: {
      dashboard: () => get('/stats/dashboard'),
    },
    media: {
      /** @param file a File or Blob on the web; in the owner app, { uri, name, type } @returns { id, url } */
      upload: (file) => {
        const form = new FormData();
        form.append('file', file);
        return request('POST', '/media', { form });
      },
    },
    instagram: {
      connection: () => get('/instagram/connection'),
      /** @returns { authorizeUrl }: send the owner there */
      connect: (body) => post('/instagram/connect', body),
      disconnect: () => del('/instagram/connection'),
      /** @param query { type?: 'all' | 'reel' | 'post' | 'story', cursor?, limit? } */
      media: (query) => get('/instagram/media', query),
    },
    compliance: {
      status: () => get('/compliance/status'),
      /** @param body { pauseStore? } */
      pause: (body) => post('/compliance/pause', body),
      resume: () => post('/compliance/resume'),
      settings: () => get('/compliance/settings'),
      updateSettings: (body) => patch('/compliance/settings', body),
      /** @param query { reason?, outcome?, automationId?, mediaId?, cursor?, limit? } */
      activity: (query) => get('/compliance/activity', query),
      /** @param query { commentId } */
      whyNoDm: (query) => get('/compliance/why-no-dm', query),
      heldJobs: (query) => get('/compliance/held-jobs', query),
      /** @param body { automationId? }: every held job when it is left out */
      discardHeld: (body) => post('/compliance/held-jobs/discard', body),
      /** @param body { confirmation }: what the owner typed */
      slowModeOverride: (body) => post('/compliance/slow-mode/override', body),
      /** @param query { list: 'optout' | 'negative' | 'handoff' } */
      words: (query) => get('/compliance/words', query),
      addWord: (body) => post('/compliance/words', body),
      removeWord: (wordId) => del(`/compliance/words/${id(wordId)}`),
    },
    automations: {
      list: (query) => get('/automations', query),
      create: (body) => post('/automations', body),
      /** Checks a message as it is typed. */
      preview: (body) => post('/automations/preview', body),
      get: (automationId) => get(`/automations/${id(automationId)}`),
      update: (automationId, body) => patch(`/automations/${id(automationId)}`, body),
      remove: (automationId) => del(`/automations/${id(automationId)}`),
      /** @param body { state } */
      setState: (automationId, body) => post(`/automations/${id(automationId)}/state`, body),
      /** @param body { variantId } */
      pickWinner: (automationId, body) => post(`/automations/${id(automationId)}/winner`, body),
      stats: (automationId) => get(`/automations/${id(automationId)}/stats`),
      /** @param body { testerId, variantLabel? } */
      sendTest: (automationId, body) => post(`/automations/${id(automationId)}/send-test`, body),
    },
    testers: {
      list: (query) => get('/testers', query),
      /** @returns { code, expiresAt }: the tester DMs the code to the business */
      createCode: (body) => post('/testers/codes', body),
      remove: (testerId) => del(`/testers/${id(testerId)}`),
    },
    iceBreakers: {
      get: () => get('/ice-breakers'),
      save: (body) => put('/ice-breakers', body),
    },
    inbox: {
      /** @param query { status?, cursor?, limit? } */
      threads: (query) => get('/inbox/threads', query),
      thread: (threadId) => get(`/inbox/threads/${id(threadId)}`),
      /** @param body { text } @returns { outcome, reason, automationPausedUntil } */
      reply: (threadId, body) => post(`/inbox/threads/${id(threadId)}/reply`, body),
      needsHuman: (query) => get('/inbox/needs-human', query),
      resolve: (itemId) => post(`/inbox/needs-human/${id(itemId)}/resolve`),
    },
    links: {
      /** @returns { finalUrl, linkType, allowed, reason, warnings }: the exact address the shopper will open */
      preview: (body) => post('/links/preview', body),
      check: (body) => post('/links/check', body),
      /** @param query { automationId?, cursor?, limit? } */
      taps: (query) => get('/links/taps', query),
    },
    measurementIds: {
      /** @param query { mediaId?, cursor?, limit? } */
      list: (query) => get('/measurement-ids', query),
      create: (body) => post('/measurement-ids', body),
      update: (measurementId, body) => patch(`/measurement-ids/${id(measurementId)}`, body),
      remove: (measurementId) => del(`/measurement-ids/${id(measurementId)}`),
    },
    facebook: {
      connection: () => get('/facebook/connection'),
      connect: (body) => post('/facebook/connect', body),
      disconnect: () => del('/facebook/connection'),
      posts: (query) => get('/facebook/posts', query),
      links: (query) => get('/facebook/links', query),
      suggestions: () => get('/facebook/link-suggestions'),
      /** @param body { igMediaId } */
      saveLink: (postId, body) => put(`/facebook/links/${id(postId)}`, body),
      removeLink: (postId) => del(`/facebook/links/${id(postId)}`),
    },
    domains: {
      list: (query) => get('/domains', query),
      /** @param body { domain } @returns the domain, with the DNS records to add */
      add: (body) => post('/domains', body),
      /** @param body { domain } */
      setPrimary: (body) => put('/domains/primary', body),
      check: (domain) => post(`/domains/${id(domain)}/check`),
      remove: (domain) => del(`/domains/${id(domain)}`),
    },
    alerts: {
      list: (query) => get('/alerts', query),
      markRead: (alertId) => post(`/alerts/${id(alertId)}/read`),
    },
  };
}

/** Walks every page of a list: for await (const product of allPages(api.products.list, { status: 'active' })) ... */
export async function* allPages(list, query = {}) {
  let cursor;
  do {
    const page = await list({ ...query, cursor });
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor);
}
