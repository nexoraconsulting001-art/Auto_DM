import { MetaApiError, classifyGraphError } from './errors.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The X-Business-Use-Case-Usage header as { percent, regainMinutes }, the highest across its entries, or null. */
export function parseUsage(header) {
  if (!header) return null;
  try {
    const entries = Object.values(JSON.parse(header)).flat();
    if (!entries.length) return null;
    return {
      percent: Math.max(...entries.map((e) => Math.max(e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0))),
      regainMinutes: Math.max(...entries.map((e) => e.estimated_time_to_regain_access ?? 0)),
    };
  } catch {
    return null;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The failure of an answer Meta did give. Without a Graph or OAuth error body, nothing is proved about delivery. */
function failure(base, status, parsed, usage) {
  const graph = isObject(parsed?.error) ? parsed.error : null;
  const oauth = !graph && typeof parsed?.error_message === 'string' ? parsed : null;
  const code = graph?.code ?? oauth?.code;
  const subcode = graph?.error_subcode;
  const kind = oauth ? 'oauth' : classifyGraphError({ status, code, subcode, message: graph?.message });
  const delivery = status === 429 || ((graph || oauth) && status < 500) ? 'none' : 'unknown';
  return new MetaApiError({ ...base, status, code, subcode, kind, delivery, usage, detail: graph?.message ?? oauth?.error_message, fbtraceId: graph?.fbtrace_id });
}

/**
 * Makes one call to Meta. Every call has a timeout, follows no redirect, and carries the token in a header. `onCall`,
 * if given, gets { method, pathname, channel?, accountId?, status, code, subcode, usage, kind, ms } after every call, ids and numbers only.
 * Resolves to { data, status, usage }. Anything else is a MetaApiError: a 200 that is not a JSON object included,
 * because it proves nothing was accepted.
 */
export function createMetaHttp({ timeoutMs = DEFAULT_TIMEOUT_MS, onCall } = {}) {
  function report(started, base, outcome) {
    try {
      onCall?.({ ...base, ...outcome, ms: Date.now() - started });
    } catch {
      // An observer can never change the outcome of a call.
    }
  }

  return async function metaCall({ base: baseUrl, version, method, pathname, query = {}, body, form, token, account }) {
    const url = new URL(`${baseUrl}/${version ? `${version}/` : ''}${pathname}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const base = { method, pathname, ...account };
    const started = Date.now();
    const init = {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(form ? { body: new URLSearchParams(form) } : {}),
    };

    let res;
    let text;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (err) {
      const kind = err?.name === 'TimeoutError' ? 'timeout' : 'network';
      report(started, base, { status: 0, kind });
      throw new MetaApiError({ ...base, kind, delivery: 'unknown', detail: kind });
    }

    const usage = parseUsage(res.headers.get('x-business-use-case-usage'));
    const parsed = parseJson(text);
    if (!res.ok || isObject(parsed?.error)) {
      const err = failure(base, res.status, parsed, usage);
      report(started, base, { status: res.status, code: err.code, subcode: err.subcode, usage, kind: err.kind });
      throw err;
    }
    if (!isObject(parsed)) {
      report(started, base, { status: res.status, usage, kind: 'malformed' });
      throw new MetaApiError({ ...base, status: res.status, kind: 'malformed', delivery: 'unknown', usage, detail: 'the answer was not a JSON object' });
    }
    report(started, base, { status: res.status, usage });
    return { data: parsed, status: res.status, usage };
  };
}
