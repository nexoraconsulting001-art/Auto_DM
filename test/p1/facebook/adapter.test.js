// Reading what a Page has published. Meta is answered by a small local server, so the shapes Meta really uses can be set exactly.
import '../../../tools/net-guard.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { MetaApiError } from '../../../src/adapters/meta/index.js';
import { RECENT_LIMIT, createPageContent } from '../../../src/adapters/facebook/index.js';

const page = { pageId: '55', token: 'page-token-secret' };
const posts = { data: [{ id: '55_1', message: 'A post', created_time: '2026-10-01T10:00:00+0000', permalink_url: 'https://www.facebook.com/55/posts/1' }] };
const reels = { data: [{ id: '777', description: 'A reel', created_time: '2026-10-02T10:00:00+0000', permalink_url: '/reel/777/' }] };

let server;
let url;
let answers;
let seen;

before(async () => {
  server = http.createServer((req, res) => {
    const where = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: where.pathname, query: Object.fromEntries(where.searchParams), authorization: req.headers.authorization });
    const edge = where.pathname.split('/').pop();
    const { status = 200, body } = answers[edge] ?? { status: 404, body: {} };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

const reader = (config = {}) => createPageContent({ graphBaseUrl: url, metaTimeoutMs: 800, ...config }, { env: {} });
const reset = (next) => { answers = next; seen = []; };

test('posts and reels come back as one list, newest first', async () => {
  reset({ posts: { body: posts }, video_reels: { body: reels } });
  const items = await reader().recent(page);
  assert.deepEqual(items.map((i) => i.id), ['55_777', '55_1']);
  assert.equal(items[1].message, 'A post');
  assert.ok(items[1].postedAt instanceof Date);
  assert.equal(items[1].postedAt.getUTCDate(), 1);
});

test('a reel gets the id a feed webhook would carry, its description, and a whole address', async () => {
  reset({ posts: { body: { data: [] } }, video_reels: { body: reels } });
  const [reel] = await reader({ fbDialogBaseUrl: url }).recent(page);
  assert.equal(reel.id, '55_777');
  assert.equal(reel.message, 'A reel');
  assert.equal(reel.permalink, `${url}/reel/777/`);
});

test('a post on both lists appears once', async () => {
  reset({ posts: { body: posts }, video_reels: { body: { data: [{ id: '55_1', description: 'Same one' }] } } });
  const items = await reader().recent(page);
  assert.equal(items.length, 1);
  assert.equal(items[0].message, 'A post');
});

test('the token goes in a header and the address asks for the most Graph allows', async () => {
  reset({ posts: { body: posts }, video_reels: { body: reels } });
  await reader().recent(page);
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.method, 'GET');
    assert.equal(call.authorization, 'Bearer page-token-secret');
    assert.equal(call.query.limit, String(RECENT_LIMIT));
    assert.doesNotMatch(JSON.stringify(call.query), /page-token-secret/);
    assert.match(call.path, /^\/v\d+\.\d+\/55\//);
  }
});

test('a reels list that fails costs the reels and not the posts', async () => {
  reset({ posts: { body: posts }, video_reels: { status: 400, body: { error: { message: 'Unsupported', code: 100 } } } });
  assert.deepEqual((await reader().recent(page)).map((i) => i.id), ['55_1']);
});

test('a dead token on either list is reported, not swallowed', async () => {
  const dead = { status: 401, body: { error: { message: 'Expired', code: 190 } } };
  reset({ posts: { body: posts }, video_reels: dead });
  await assert.rejects(() => reader().recent(page), (err) => err instanceof MetaApiError && err.kind === 'token_invalid');
  reset({ posts: dead, video_reels: { body: reels } });
  await assert.rejects(() => reader().recent(page), (err) => err instanceof MetaApiError && err.kind === 'token_invalid');
});

test('odd answers are survived: no id skipped, no list empty, a bad time and a bad address dropped', async () => {
  reset({ posts: { body: { data: [{ message: 'no id' }, { id: '55_2', created_time: 'soon', permalink_url: 'javascript:alert(1)' }] } }, video_reels: { body: { nothing: true } } });
  const items = await reader().recent(page);
  assert.equal(items.length, 1);
  assert.equal(items[0].postedAt, null);
  assert.equal(items[0].permalink, '');
  assert.equal(items[0].message, '');
});

test('an address that is not Meta\'s is refused when the reader is built', () => {
  assert.throws(() => createPageContent({ fbGraphBaseUrl: 'https://evil.example', graphBaseUrl: '' }, { env: {} }), /not an allowed Meta address/);
});

test('this track holds no way to message anyone: nothing here reaches a send call or Meta\'s messages edge', () => {
  const root = fileURLToPath(new URL('../../../src/', import.meta.url));
  const dirs = ['adapters/facebook', 'modules/facebook'];
  const sources = dirs.flatMap((dir) => fs.readdirSync(`${root}${dir}`).map((file) => fs.readFileSync(`${root}${dir}/${file}`, 'utf8')));
  assert.ok(sources.length >= 6);
  for (const source of sources) {
    assert.doesNotMatch(source, /\.(sender|sendPrivateReply|sendPrivateReplyButton|sendMessage|replyToComment)\(/);
    assert.doesNotMatch(source, /\/messages\b/);
    assert.doesNotMatch(source, /graph\.facebook\.com/);
  }
});
