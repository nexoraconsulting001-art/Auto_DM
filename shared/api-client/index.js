/**
 * The client for the seller API at /api/v1, written by hand from src/contracts/api and kept in step with it
 * by a test. No dependencies, so the web console and the owner app can both use it.
 *
 *   const api = createApiClient();                                                  // web console: same site, cookie session
 *   const api = createApiClient({ baseUrl: 'https://app.example/api/v1', getToken, getTenantId, app });   // owner app: access token
 *
 *   const { items, nextCursor } = await api.products.list({ search: 'pot', limit: 20 });
 *   await api.products.update(12, { active: false });
 *
 * A method that names one thing takes its id first, then its input. Every failure is thrown as an ApiError.
 */
export class ApiError extends Error {
  /** `status` is 0 when the server could not be reached; `code` is from the API's error format. */
  constructor({ status, code, message, fields, reason, requestId, storeUrl }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields ?? {};
    this.reason = reason;
    this.requestId = requestId;
    /** With code `update_required` (426): where to get the newer app. */
    this.storeUrl = storeUrl;
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
    storeUrl: body?.storeUrl,
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl] where /api/v1 is; defaults to this site
 * @param {() => (string|null|Promise<string|null>)} [options.getToken] the bearer token, when not using a cookie session
 * @param {() => (number|string|null|Promise<number|string|null>)} [options.getTenantId] the business to work in, sent as X-Tenant-Id (the owner app's switcher)
 * @param {{ name: 'owner' | 'shopper', version: string, platform: 'android' | 'ios' }} [options.app] sent as X-App, X-App-Version and X-App-Platform
 * @param {(error: ApiError) => void} [options.onUnauthorized] called on any 401
 * @param {(error: ApiError) => void} [options.onUpdateRequired] called on 426 `update_required`; error.storeUrl is the store link
 * @param {(error: ApiError) => void} [options.onReauthRequired] called on 403 `reauth_required`: re-auth, then repeat the request
 * @param {typeof fetch} [options.fetch] replaces the global fetch
 */
export function createApiClient({ baseUrl = '/api/v1', getToken, getTenantId, app, onUnauthorized, onUpdateRequired, onReauthRequired, fetch: send = (...args) => globalThis.fetch(...args) } = {}) {
  let csrf = ''; // the cookie session's token, learned from auth.login and auth.me

  async function request(method, path, { json, form } = {}) {
    const headers = { accept: 'application/json' };
    const token = await getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    const tenant = await getTenantId?.();
    if (tenant !== undefined && tenant !== null && tenant !== '') headers['x-tenant-id'] = String(tenant);
    if (app) Object.assign(headers, { 'x-app': app.name, 'x-app-version': app.version, 'x-app-platform': app.platform });
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
      if (error.code === 'update_required') onUpdateRequired?.(error);
      if (error.code === 'reauth_required') onReauthRequired?.(error);
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
      // Passwordless sign-in (5.11, 10.2, 10.3). Sessions come back as AuthSession: for transport 'bearer' accessToken,
      // accessExpiresInSeconds and refreshToken; for 'cookie' the CSRF token, which this client then sends by itself.
      /** @param body { phone } @returns { sent, channel, expiresInSeconds, resendInSeconds, alternatives }: the same for every number */
      start: (body) => post('/auth/start', body),
      /** @param body { phone, code, transport?, device?: { id, name, platform, app?, appVersion? }, tenantId? } */
      verify: (body) => post('/auth/verify', body).then(rememberCsrf),
      /** The end of a browser sign-in. @param body { code, verifier, transport?, device?, tenantId? } */
      exchange: (body) => post('/auth/exchange', body).then(rememberCsrf),
      /** @param body { identityToken, nonce, name?, transport?, device?, tenantId? } */
      apple: (body) => post('/auth/apple', body).then(rememberCsrf),
      /** @param body { refreshToken } @returns { accessToken, accessExpiresInSeconds, refreshToken }: store the new refresh token before using the access token */
      refresh: (body) => post('/auth/refresh', body),
      devices: () => get('/auth/devices'),
      revokeDevice: (deviceId) => del(`/auth/devices/${id(deviceId)}`),
      /** @returns { sent, channel, expiresInSeconds, resendInSeconds } */
      reauthStart: () => post('/auth/reauth/start'),
      /** @param body { code } or { deviceSecret } @returns { freshUntil } */
      reauthVerify: (body) => post('/auth/reauth/verify', body),
      /** Needs a fresh session. @returns { deviceSecret }, once: keep it in SecureStore behind fingerprint or face unlock */
      enableDeviceUnlock: () => post('/auth/device-unlock'),
      /** @param body { kind: 'phone', phone, code? } | { kind: 'google', code, verifier } | { kind: 'apple', identityToken, nonce } */
      linkIdentity: (body) => post('/auth/identities', body),
      /** @param body { confirm: 'DELETE' } @returns { status, requestedAt, dueAt } */
      deleteAccount: (body) => post('/auth/delete-account', body),
    },
    // The team (5.11): owner only, and every change needs a fresh session.
    team: {
      /** @param query { cursor?, limit? } @returns { items, nextCursor, invites }: members, and every open invitation */
      list: (query) => get('/team', query),
      /** @param body { contact, role, permissions? } */
      invite: (body) => post('/team/invites', body),
      update: (memberId, body) => patch(`/team/${id(memberId)}`, body),
      remove: (memberId) => del(`/team/${id(memberId)}`),
    },
    // Before sign-in (10.2): the minimum version, the store link and which sign-in buttons to show.
    app: {
      /** @param query { app?: 'owner' | 'shopper', platform: 'android' | 'ios', tenantId? } */
      requirements: (query) => get('/app/requirements', query),
    },
    // What Bhava tells this seller (5.13, 10.5): the in-app list, the choices per kind and channel, and this device's push token.
    notifications: {
      /** @param query { unread?: '1', cursor?, limit? } @returns { items, nextCursor, unread } */
      list: (query) => get('/notifications', query),
      /** @param body { ids: number[] } | { all: true } */
      markRead: (body) => post('/notifications/read', body),
      /** @returns { quietHours, events, kinds, available } */
      prefs: () => get('/notifications/prefs'),
      /** @param body { quietHours?: { enabled?, from?, to?, timezone? }, events?: { [kind]: { push?, email?, whatsapp? } } } */
      savePrefs: (body) => put('/notifications/prefs', body),
    },
    push: {
      /** @param body { deviceId, platform: 'android' | 'ios', token, appVersion? } */
      register: (body) => post('/push/devices', body),
      unregister: (deviceId) => del(`/push/devices/${id(deviceId)}`),
    },
    products: {
      /** @param query { search?, status?: 'all' | 'active' | 'archived' | 'featured' | 'attention' | 'sold_out' | 'price_changed', category?, source?, cursor?, limit? } */
      list: (query) => get('/products', query),
      create: (body) => post('/products', body),
      get: (productId) => get(`/products/${id(productId)}`),
      update: (productId, body) => patch(`/products/${id(productId)}`, body),
      remove: (productId) => del(`/products/${id(productId)}`),
      /** Re-checks an imported product's page now, in the background. */
      recheck: (productId) => post(`/products/${id(productId)}/recheck`),
    },
    catalogSettings: {
      get: () => get('/catalog/settings'),
      /** @param body { recheckHours? } */
      update: (body) => patch('/catalog/settings', body),
    },
    categories: {
      list: (query) => get('/categories', query),
      create: (body) => post('/categories', body),
      /** @param body { ids }: every category, in the order wanted */
      reorder: (body) => put('/categories/order', body),
      get: (categoryId) => get(`/categories/${id(categoryId)}`),
      update: (categoryId, body) => patch(`/categories/${id(categoryId)}`, body),
      remove: (categoryId) => del(`/categories/${id(categoryId)}`),
      /** @returns { categoryId, items }: pinned first, then the rest */
      reels: (categoryId) => get(`/categories/${id(categoryId)}/reels`),
      /** @param body { pinned, order }: the whole order at once */
      setReels: (categoryId, body) => put(`/categories/${id(categoryId)}/reels`, body),
      /** @param body { pageId, at?: 'top' | 'bottom' } */
      addReel: (categoryId, body) => post(`/categories/${id(categoryId)}/reels`, body),
      /** @param body { pageId } */
      removeReel: (categoryId, body) => post(`/categories/${id(categoryId)}/reels/remove`, body),
      pin: (categoryId, body) => post(`/categories/${id(categoryId)}/reels/pin`, body),
      unpin: (categoryId, body) => post(`/categories/${id(categoryId)}/reels/unpin`, body),
      /** @param body { pageId, startsAt, endsAt }: both null clears the window */
      schedule: (categoryId, body) => put(`/categories/${id(categoryId)}/reels/schedule`, body),
      rules: (categoryId) => get(`/categories/${id(categoryId)}/rules`),
      /** @param body { match: 'caption_keyword' | 'hashtag' | 'product_category', value?, productCategoryId?, joinAt?, active? } */
      addRule: (categoryId, body) => post(`/categories/${id(categoryId)}/rules`, body),
    },
    categoryRules: {
      update: (ruleId, body) => patch(`/category-rules/${id(ruleId)}`, body),
      remove: (ruleId) => del(`/category-rules/${id(ruleId)}`),
      /** "Apply to existing reels" @returns { added } */
      apply: (ruleId) => post(`/category-rules/${id(ruleId)}/apply`),
    },
    imports: {
      /** @param body { url } @returns { status: 'draft' | 'existing' | 'refused' | 'failed', draft, productId, reason, message } */
      link: (body) => post('/imports/link', body),
      /** @param body { urls }: up to 25 @returns the job */
      bulk: (body) => post('/imports/bulk', body),
      /** @param file a CSV File or Blob @returns the job */
      csv: (file) => {
        const form = new FormData();
        form.append('file', file);
        return request('POST', '/imports/csv', { form });
      },
      /** @param body { storeUrl } @returns the job */
      shopify: (body) => post('/imports/shopify', body),
      list: (query) => get('/imports', query),
      adapters: () => get('/import-adapters'),
      get: (jobId) => get(`/imports/${id(jobId)}`),
      /** @param query { status?, cursor?, limit? } */
      items: (jobId, query) => get(`/imports/${id(jobId)}/items`, query),
    },
    importItems: {
      /** @param body the product as the owner corrected it @returns { productId } */
      save: (itemId, body) => post(`/import-items/${id(itemId)}/save`, body),
    },
    pages: {
      /** @param query { kind?, status?, search?, cursor?, limit? } */
      list: (query) => get('/pages', query),
      /** @param body { channel?, kind, mediaId, productIds, slug?, headline?, ... } */
      create: (body) => post('/pages', body),
      /** The account's reels, posts and stories to make a page for. @param query { kind?, cursor?, limit? } */
      media: (query) => get('/page-media', query),
      get: (pageId) => get(`/pages/${id(pageId)}`),
      update: (pageId, body) => patch(`/pages/${id(pageId)}`, body),
      remove: (pageId) => del(`/pages/${id(pageId)}`),
    },
    pageSettings: {
      get: () => get('/page-settings'),
      /** @param body { whatsappOrder?, whatsappTemplate?, landingNoindex?, moreReels? } */
      update: (body) => patch('/page-settings', body),
    },
    pageBlocks: {
      /** @param query { surface?: 'landing' | 'creator' | 'store_home' } */
      get: (query) => get('/page-blocks', query),
      /** @param body { surface, blocks: [{ block, visible?, settings? }] } */
      save: (body) => put('/page-blocks', body),
    },
    themes: {
      presets: () => get('/theme/presets'),
      get: () => get('/theme'),
      /** @param body { preset, tuneAccent? } */
      choose: (body) => put('/theme', body),
      /** @param body { sealText?, tickerItems? } */
      updateText: (body) => patch('/theme', body),
      /** @param body { website } */
      readSite: (body) => post('/theme/site-reads', body),
      siteReads: (query) => get('/theme/site-reads', query),
      applySiteRead: (readId) => post(`/theme/site-reads/${id(readId)}/apply`),
    },
    creator: {
      get: () => get('/creator-page'),
      update: (body) => patch('/creator-page', body),
      /** @param query { slug } @returns { slug, available, message } */
      checkSlug: (query) => get('/creator-page/slug', query),
    },
    leads: {
      /** @param query { source?, consent?: 'all' | 'active' | 'withdrawn', cursor?, limit? } */
      list: (query) => get('/leads', query),
      get: (leadId) => get(`/leads/${id(leadId)}`),
      remove: (leadId) => del(`/leads/${id(leadId)}`),
      /** @param body { channels? }: all channels when none are named */
      revokeConsent: (leadId, body) => post(`/leads/${id(leadId)}/revoke-consent`, body),
    },
    leadForms: {
      get: () => get('/lead-forms'),
      /** @param body { surface, enabled?, offerLine? } */
      update: (body) => patch('/lead-forms', body),
      /** @param body { channels } @returns the forms with the new consent version */
      setConsent: (body) => put('/lead-forms/consent', body),
    },
    leadDownloads: {
      list: (query) => get('/lead-downloads', query),
      /** @param body { format?: 'csv' | 'xlsx' } */
      create: (body) => post('/lead-downloads', body),
      get: (downloadId) => get(`/lead-downloads/${id(downloadId)}`),
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
      // Phase 4: a checkout order moves through these, never by setting a status.
      timeline: (orderId) => get(`/orders/${id(orderId)}/timeline`),
      /** @param body { to: 'packed' | 'shipped' | 'delivered', note? } */
      advance: (orderId, body) => post(`/orders/${id(orderId)}/advance`, body),
      /** Before shipment only. @param body { reason?, note? } */
      cancel: (orderId, body) => post(`/orders/${id(orderId)}/cancel`, body),
      releaseHold: (orderId, body) => post(`/orders/${id(orderId)}/release-hold`, body),
      reinstate: (orderId) => post(`/orders/${id(orderId)}/reinstate`),
      addNote: (orderId, body) => post(`/orders/${id(orderId)}/notes`, body),
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
    insights: {
      status: () => get('/insights/status'),
      /** @param query { range?: '7' | '28' | '90' | 'custom', from?, to? } */
      account: (query) => get('/insights/account', query),
      /** @param query { timeframe?: 'this_week' | 'this_month' } */
      audience: (query) => get('/insights/audience', query),
      /** @param query { kind?, includeDeleted?, cursor?, limit? } */
      media: (query) => get('/insights/media', query),
      mediaDetail: (mediaId) => get(`/insights/media/${id(mediaId)}`),
      stories: (query) => get('/insights/stories', query),
      /** @param query { kind?, cursor?, limit? } */
      funnels: (query) => get('/insights/funnels', query),
      funnel: (mediaId) => get(`/insights/funnels/${id(mediaId)}`),
      /** @param query { rank?, kind?, linkMode?, days?, cursor?, limit? } */
      top: (query) => get('/insights/top', query),
      bestTime: () => get('/insights/best-time'),
      /** Limited to once per 15 minutes. @returns { refreshed, message, lastUpdatedAt, nextRefreshAt } */
      refresh: () => post('/insights/refresh'),
    },
    destinations: {
      connections: () => get('/destinations/connections'),
      /** @param body { enabled } @returns { enabled, snippet } */
      setSiteTag: (body) => put('/destinations/site-tag', body),
      reports: (query) => get('/destinations/reports', query),
      /** @param file a CSV @param query { source?: 'amazon' | 'affiliate', network? } */
      uploadReport: (file, query) => {
        const form = new FormData();
        form.append('file', file);
        return request('POST', withQuery('/destinations/reports', query), { form });
      },
    },
    reachGuard: {
      status: () => get('/reach-guard'),
      /** @param body { reachDropPercent?, mediaDropPercent?, clearPercent? } */
      setThresholds: (body) => patch('/reach-guard/thresholds', body),
      trips: (query) => get('/reach-guard/trips', query),
    },
    accountHealth: {
      get: () => get('/account-health'),
      history: (query) => get('/account-health/history', query),
    },
    traffic: {
      /** @param query { range?, from?, to?, compare?: 'none' | 'previous', page? } */
      summary: (query) => get('/traffic/summary', query),
      sources: (query) => get('/traffic/sources', query),
      trend: (query) => get('/traffic/trend', query),
      heatmap: (query) => get('/traffic/heatmap', query),
      pages: (query) => get('/traffic/pages', query),
      breakdown: (query) => get('/traffic/breakdown', query),
      realtime: () => get('/traffic/realtime'),
    },
    tags: {
      get: () => get('/tags'),
      /** @param body { meta?: { enabled?, pixelId?, capiToken? }, ga4?: { enabled?, measurementId?, apiSecret? } } */
      update: (body) => patch('/tags', body),
      health: () => get('/tags/health'),
    },
    explore: {
      catalog: () => get('/explore/catalog'),
      /** @param body { metrics, dimensions?, filters?, thresholds?, range?, from?, to?, compare?, sortBy?, sortDirection?, chart?, page?, limit? } */
      query: (body) => post('/explore/query', body),
    },
    savedViews: {
      list: (query) => get('/saved-views', query),
      /** @param body { name, visibility?, definition } */
      create: (body) => post('/saved-views', body),
      get: (viewId) => get(`/saved-views/${id(viewId)}`),
      update: (viewId, body) => patch(`/saved-views/${id(viewId)}`, body),
      remove: (viewId) => del(`/saved-views/${id(viewId)}`),
      pin: (viewId) => post(`/saved-views/${id(viewId)}/pin`),
      unpin: (viewId) => del(`/saved-views/${id(viewId)}/pin`),
    },
    dashboard: {
      cards: () => get('/dashboard/cards'),
    },
    funnels: {
      list: (query) => get('/funnels', query),
      /** @param body { name, steps, countBy?, windowMinutes? } */
      create: (body) => post('/funnels', body),
      get: (funnelId) => get(`/funnels/${id(funnelId)}`),
      update: (funnelId, body) => patch(`/funnels/${id(funnelId)}`, body),
      remove: (funnelId) => del(`/funnels/${id(funnelId)}`),
      /** @param query { range?, from?, to?, breakdown?, compare? } */
      results: (funnelId, query) => get(`/funnels/${id(funnelId)}/results`, query),
    },
    cohorts: {
      /** @param query { kind?: 'visitors' | 'buyers', groupBy?, range?, from?, to? } */
      get: (query) => get('/cohorts', query),
    },
    downloads: {
      list: (query) => get('/downloads', query),
      /** @param body { source, format?, query?, funnelId?, cohort?, from?, to? } @returns { id, status, fileUrl, ... } */
      create: (body) => post('/downloads', body),
      get: (downloadId) => get(`/downloads/${id(downloadId)}`),
    },
    reports: {
      /** @param query { kind?, cursor?, limit? } */
      list: (query) => get('/reports', query),
      preferences: () => get('/reports/preferences'),
      updatePreferences: (body) => patch('/reports/preferences', body),
      /** @param body { token, report? } */
      unsubscribe: (body) => post('/reports/unsubscribe', body),
      get: (reportId) => get(`/reports/${id(reportId)}`),
    },
    scheduledReports: {
      list: (query) => get('/scheduled-reports', query),
      /** @param body { viewId, frequency?, hourOfDay?, weekday?, dayOfMonth?, format?, enabled? } */
      create: (body) => post('/scheduled-reports', body),
      update: (reportId, body) => patch(`/scheduled-reports/${id(reportId)}`, body),
      remove: (reportId) => del(`/scheduled-reports/${id(reportId)}`),
      /** @param body { email }: an outside address, owner only */
      addRecipient: (reportId, body) => post(`/scheduled-reports/${id(reportId)}/recipients`, body),
      removeRecipient: (recipientId) => del(`/scheduled-report-recipients/${id(recipientId)}`),
    },
    apiKeys: {
      list: (query) => get('/api-keys', query),
      /** @param body { name } @returns the key once, as key */
      create: (body) => post('/api-keys', body),
      revoke: (keyId) => del(`/api-keys/${id(keyId)}`),
    },
    // Phase 4 (PRD 9): the store. Orders as a CSV file.
    orderDownloads: {
      list: (query) => get('/order-downloads', query),
      create: (body) => post('/order-downloads', body),
      get: (itemId) => get(`/order-downloads/${id(itemId)}`),
    },
    // Payments, the settlement statement and refunds (9.6 to 9.8).
    paymentSettings: {
      get: () => get('/payment-settings'),
      update: (body) => patch('/payment-settings', body),
    },
    paymentAccount: {
      get: () => get('/payment-account'),
      startLinked: (body) => post('/payment-account/linked', body),
      connectUrl: () => post('/payment-account/connect'),
      setMode: (body) => put('/payment-account/mode', body),
      disconnect: () => del('/payment-account/own'),
    },
    payments: {
      forOrder: (orderId) => get(`/orders/${id(orderId)}/payments`),
    },
    settlements: {
      list: (query) => get('/settlements', query),
      summary: (query) => get('/settlements/summary', query),
    },
    refunds: {
      forOrder: (orderId) => get(`/orders/${id(orderId)}/refunds`),
      /** Owner only. @param body { amountPaise, reason?, paymentId?, reference?, returnId?, idempotencyKey, password } */
      create: (itemId, body) => post(`/orders/${id(itemId)}/refunds`, body),
      get: (itemId) => get(`/refunds/${id(itemId)}`),
      retry: (itemId) => post(`/refunds/${id(itemId)}/retry`),
    },
    // Shipping, stock, invoices and returns (9.10, 9.12, 9.13, 9.17).
    shippingSettings: {
      get: () => get('/shipping-settings'),
      update: (body) => patch('/shipping-settings', body),
    },
    shipping: {
      serviceability: (query) => get('/shipping/serviceability', query),
    },
    shipments: {
      forOrder: (orderId) => get(`/orders/${id(orderId)}/shipments`),
      /** "Ready to ship". @param body { weightGrams?, lengthCm?, breadthCm?, heightCm? } */
      create: (itemId, body) => post(`/orders/${id(itemId)}/shipments`, body),
      get: (itemId) => get(`/shipments/${id(itemId)}`),
      cancel: (itemId) => post(`/shipments/${id(itemId)}/cancel`),
      label: (itemId) => get(`/shipments/${id(itemId)}/label`),
    },
    inventory: {
      list: (query) => get('/inventory', query),
      /** @param body { productId, variantId?, stock? | delta?, lowStockThreshold?, note? } */
      adjust: (body) => post('/inventory/adjust', body),
      movements: (query) => get('/inventory/movements', query),
    },
    inventorySettings: {
      get: () => get('/inventory/settings'),
      update: (body) => patch('/inventory/settings', body),
    },
    invoiceSettings: {
      get: () => get('/invoice-settings'),
      update: (body) => patch('/invoice-settings', body),
    },
    invoices: {
      list: (query) => get('/invoices', query),
      get: (itemId) => get(`/invoices/${id(itemId)}`),
    },
    returnSettings: {
      get: () => get('/return-settings'),
      update: (body) => patch('/return-settings', body),
    },
    returns: {
      list: (query) => get('/returns', query),
      get: (itemId) => get(`/returns/${id(itemId)}`),
      approve: (itemId) => post(`/returns/${id(itemId)}/approve`),
      decline: (itemId, body) => post(`/returns/${id(itemId)}/decline`, body),
      /** @param body { condition: 'good' | 'not_restockable' } */
      receive: (itemId, body) => post(`/returns/${id(itemId)}/receive`, body),
      close: (itemId, body) => post(`/returns/${id(itemId)}/close`, body),
    },
    // Coupons, reviews, saves and loyalty (9.14, 9.19 to 9.21).
    coupons: {
      list: (query) => get('/coupons', query),
      create: (body) => post('/coupons', body),
      get: (itemId) => get(`/coupons/${id(itemId)}`),
      update: (itemId, body) => patch(`/coupons/${id(itemId)}`, body),
      remove: (itemId) => del(`/coupons/${id(itemId)}`),
      stats: (itemId) => get(`/coupons/${id(itemId)}/stats`),
    },
    reviews: {
      list: (query) => get('/reviews', query),
      approve: (itemId) => post(`/reviews/${id(itemId)}/approve`),
      hide: (itemId) => post(`/reviews/${id(itemId)}/hide`),
      reply: (itemId, body) => put(`/reviews/${id(itemId)}/reply`, body),
    },
    wishlist: {
      counts: (query) => get('/wishlist/counts', query),
    },
    loyaltySettings: {
      get: () => get('/loyalty/settings'),
      update: (body) => patch('/loyalty/settings', body),
    },
    loyalty: {
      members: (query) => get('/loyalty/members', query),
      ledger: (itemId, query) => get(`/loyalty/members/${id(itemId)}/ledger`, query),
      adjust: (itemId, body) => post(`/loyalty/members/${id(itemId)}/adjust`, body),
      referrals: (query) => get('/loyalty/referrals', query),
    },
    // Messages to shoppers: WhatsApp and email only (9.15, 9.16).
    alertSettings: {
      get: () => get('/alert-settings'),
      update: (body) => patch('/alert-settings', body),
    },
    whatsappAccount: {
      get: () => get('/whatsapp-account'),
      connect: (body) => put('/whatsapp-account', body),
      disconnect: () => del('/whatsapp-account'),
    },
    whatsappTemplates: {
      all: () => get('/whatsapp-templates'),
      sync: () => post('/whatsapp-templates/sync'),
    },
    orderAlerts: {
      list: (query) => get('/order-alerts', query),
      retry: (itemId) => post(`/order-alerts/${id(itemId)}/retry`),
    },
    cartReminders: {
      get: () => get('/cart-reminders'),
      update: (body) => patch('/cart-reminders', body),
      stats: (query) => get('/cart-reminders/stats', query),
    },
    // Shopify sync (9.11).
    shopify: {
      get: () => get('/shopify'),
      /** @param body { shopDomain, accessToken, webhookSecret, mode? } */
      connect: (body) => put('/shopify', body),
      setMode: (body) => patch('/shopify', body),
      disconnect: () => del('/shopify'),
      reconcile: () => post('/shopify/reconcile'),
      conflicts: (query) => get('/shopify/conflicts', query),
    },
    // Shoppers and privacy (9.17, 9.18, 9.22).
    shoppers: {
      list: (query) => get('/shoppers', query),
      get: (itemId) => get(`/shoppers/${id(itemId)}`),
    },
    shopperDownloads: {
      list: (query) => get('/shopper-downloads', query),
      create: (body) => post('/shopper-downloads', body),
      get: (itemId) => get(`/shopper-downloads/${id(itemId)}`),
    },
    privacy: {
      get: () => get('/privacy'),
      update: (body) => patch('/privacy', body),
    },
    policies: {
      all: () => get('/policies'),
      /** @param body { kind: 'privacy' | 'terms' | 'refund' | 'shipping', body } */
      save: (body) => put('/policies', body),
    },
    consentNotice: {
      get: () => get('/consent-notice'),
      publish: (body) => post('/consent-notice', body),
    },
    dataRequests: {
      list: (query) => get('/data-requests', query),
      create: (body) => post('/data-requests', body),
      get: (itemId) => get(`/data-requests/${id(itemId)}`),
    },
    // The business's own shopper app (10.7 to 10.14). Where a path takes one, `platform` is 'android' or 'ios'.
    appPublishing: {
      get: () => get('/app-publishing'),
      save: (body) => put('/app-publishing', body),
      validate: () => post('/app-publishing/validate'),
      /** @param query { platform?, cursor?, limit? } */
      builds: (query) => get('/app-publishing/builds', query),
      /** @param body { platforms: ('android' | 'ios')[], requestKey } */
      requestBuild: (body) => post('/app-publishing/builds', body),
      submissions: () => get('/app-publishing/submissions'),
    },
    appListing: {
      get: (platform) => get(`/app-listing/${id(platform)}`),
      save: (platform, body) => put(`/app-listing/${id(platform)}`, body),
      assets: (platform) => get(`/app-listing/${id(platform)}/assets`),
    },
    storeAccess: {
      get: () => get('/store-access'),
      /** Needs a fresh session. @param body { accountType?, legalName?, dunsStatus?, playAccountAfterCutoff?, closedTest?, ascKey? } */
      save: (platform, body) => put(`/store-access/${id(platform)}`, body),
      check: (platform) => post(`/store-access/${id(platform)}/check`),
    },
    pushCampaigns: {
      list: (query) => get('/push-campaigns', query),
      summary: () => get('/push-campaigns/summary'),
      /** @param body { title, body, couponId?, linkPath?, requestKey } */
      send: (body) => post('/push-campaigns', body),
    },
    pushCredentials: {
      get: () => get('/push-credentials'),
      /** Needs a fresh session. @param body { fcm?: { serviceAccount } | null, apns?: { keyId, teamId, key, env } | null } */
      save: (body) => put('/push-credentials', body),
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
