import http from 'node:http';
import { createMeta } from '../../../tools/sim/meta/index.mjs';

export const ACCOUNT = { igUserId: '17841400000000001', username: 'kesar.store', token: 'token-kesar' };
export const OTHER = { igUserId: '17841400000000002', username: 'leaf.store', token: 'token-leaf' };
export const SUBSCRIBED = ['comments', 'messages', 'messaging_postbacks', 'mentions'];
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** A fixed moment, so tests at the edge of a window do not depend on when they run. */
export const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

/** fetch, with the body read and parsed. `status: null` means the connection failed. */
export async function request(url, init = {}) {
  const { json, ...rest } = init;
  const options = json === undefined ? rest : { ...rest, method: rest.method ?? 'POST', headers: { 'content-type': 'application/json', ...rest.headers }, body: JSON.stringify(json) };
  try {
    const res = await fetch(url, { redirect: 'manual', ...options });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Left null; tests of malformed responses read `text`.
    }
    return { status: res.status, headers: res.headers, text, body };
  } catch (err) {
    return { status: null, error: err };
  }
}

/** A running Meta simulator with one account seeded, closed when the test ends. The clock is frozen at T0. */
export async function startMeta(t, options = {}, { account = ACCOUNT } = {}) {
  const meta = await createMeta(options).start();
  t.after(() => meta.close());
  await meta.post('/clock', { freeze: true, now: T0 });
  if (account) await meta.post('/accounts', account);
  return meta;
}

export const graphUrl = (meta, path, query = {}) => {
  const url = new URL(`${meta.url}/v23.0/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
};

export const bearer = (token) => ({ authorization: `Bearer ${token}` });

export const graphGet = (meta, path, { token = ACCOUNT.token, query } = {}) => request(graphUrl(meta, path, query), { headers: bearer(token) });

export const graphPost = (meta, path, json, { token = ACCOUNT.token, query } = {}) => request(graphUrl(meta, path, query), { json, headers: bearer(token) });

export const sendDm = (meta, recipient, message, { account = ACCOUNT, token = account.token, ...rest } = {}) =>
  graphPost(meta, `${account.igUserId}/messages`, { recipient, message, ...rest }, { token });

export const privateReply = (meta, commentId, message = { text: 'hello' }, options) => sendDm(meta, { comment_id: commentId }, message, options);

export const buttonMessage = ({ text = 'Here is the link', buttons = [{ type: 'web_url', url: 'https://shop.example/r/1', title: 'Shop now' }] } = {}) => ({
  attachment: { type: 'template', payload: { template_type: 'button', text, buttons } },
});

let commentSeq = 0;

/** A comment from a shopper on `account`'s reel. Returns its id. */
export async function addComment(meta, { account = ACCOUNT, id = `c${++commentSeq}`, mediaId = 'reel-1', from = { id: 'shopper-1', username: 'asha' }, text = 'LINK', ...rest } = {}) {
  await meta.post('/comments', { igUserId: account.igUserId, id, mediaId, from, text, ...rest });
  return id;
}

export const errorCode = (res) => res.body?.error?.code;
export const errorSubcode = (res) => res.body?.error?.error_subcode;

export const sent = async (meta, query) => (await meta.get('/sent', query)).sent;

/** A local HTTP server standing in for the app: records every request with its raw bytes. */
export async function startReceiver(t, respond = () => ({ status: 200, body: 'ok' })) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) };
      received.push(entry);
      const out = respond(entry, received.length);
      if (out.hang) return;
      res.writeHead(out.status ?? 200, out.headers ?? {});
      res.end(out.body ?? '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  t.after(close);
  return { received, url: `http://127.0.0.1:${server.address().port}`, close };
}

export async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= end) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
