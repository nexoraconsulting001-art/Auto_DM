// The Meta client: only Meta's hosts, a timeout on every call, and failures described well enough to decide what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createMeta, signedRequest } from '../../../tools/sim/meta/index.mjs';
import { MetaApiError, META_HOSTS, classifyGraphError, createMetaClient, metaUrls, parseUsage, verifyHubSignature, verifySignedRequest, wireMessage } from '../../../src/adapters/meta/index.js';

const PROD = { NODE_ENV: 'production' };
const account = (igUserId, token) => ({ igUserId, token });

async function withSim(run) {
  const meta = createMeta();
  await meta.start();
  try {
    const { token } = await meta.post('/accounts', { igUserId: '1784', username: 'shop' });
    await run(meta, token);
  } finally {
    await meta.close();
  }
}

test('with no address given, every call goes to Meta\'s own hosts', () => {
  const urls = metaUrls({}, {});
  assert.deepEqual({ ...urls }, { ...META_HOSTS });
});

test('GRAPH_BASE_URL points every service at one simulator, and each can be set alone', () => {
  const sim = 'http://127.0.0.1:9101';
  assert.deepEqual(new Set(Object.values(metaUrls({ graphBaseUrl: sim }, {}))), new Set([sim]));
  assert.equal(metaUrls({ igApiBaseUrl: sim }, {}).instagramApi, sim);
  assert.equal(metaUrls({ igApiBaseUrl: sim }, {}).graph, META_HOSTS.graph);
});

test('a simulator address is refused in production, for every service', () => {
  const sim = 'http://127.0.0.1:9101';
  for (const key of ['graphBaseUrl', 'igDialogBaseUrl', 'igApiBaseUrl', 'fbGraphBaseUrl', 'fbDialogBaseUrl']) {
    assert.throws(() => metaUrls({ [key]: sim }, PROD), { code: 'ESIMREFUSED' }, key);
    assert.throws(() => createMetaClient({ [key]: sim }, { env: PROD }), { code: 'ESIMREFUSED' }, key);
  }
  assert.throws(() => metaUrls({ graphBaseUrl: 'http://localhost:9' }, PROD), { code: 'ESIMREFUSED' });
});

test('an address that is not Meta\'s throws api.host_blocked, in or out of production', () => {
  for (const bad of ['https://graph.instagram.com.evil.example', 'https://evil.example', 'http://graph.instagram.com', 'https://user:pw@graph.instagram.com', 'https://graph.instagram.com/extra', 'not a url']) {
    for (const env of [{}, PROD]) {
      assert.throws(() => metaUrls({ graphBaseUrl: bad }, env), (err) => err.reason === 'api.host_blocked', bad);
    }
  }
});

test('a call that never answers stops at the timeout, and its outcome is unknown', async () => {
  await withSim(async (meta, token) => {
    await meta.fault({ kind: 'timeout', times: 'forever', match: { path: '/v23.0/1784/messages' } });
    const client = createMetaClient({ graphBaseUrl: meta.url, metaTimeoutMs: 120 });
    const started = Date.now();
    await assert.rejects(() => client.sender(account('1784', token)).dm('42', { text: 'hi' }), (err) => {
      assert.ok(err instanceof MetaApiError);
      assert.equal(err.kind, 'timeout');
      assert.equal(err.delivery, 'unknown');
      return true;
    });
    assert.ok(Date.now() - started < 3000);
  });
});

test('each way a call can fail is classified, and only proven non-delivery says so', async () => {
  await withSim(async (meta, token) => {
    const client = createMetaClient({ graphBaseUrl: meta.url });
    const send = () => client.sender(account('1784', token)).dm('42', { text: 'hi' });
    const cases = [
      [{ kind: 'server_error' }, { kind: 'server_error', delivery: 'unknown', status: 500 }],
      [{ kind: 'malformed', mode: 'html' }, { kind: 'malformed', delivery: 'unknown', status: 200 }],
      [{ kind: 'malformed', mode: 'empty' }, { kind: 'malformed', delivery: 'unknown', status: 200 }],
      [{ kind: 'malformed', mode: 'wrong_shape' }, { kind: 'malformed', delivery: 'unknown', status: 200 }],
      [{ kind: 'drop' }, { kind: 'network', delivery: 'unknown', status: 0 }],
      [{ kind: 'rate_limit', code: 613 }, { kind: 'throttled', delivery: 'none', status: 429, code: 613 }],
      [{ kind: 'rate_limit', code: 80002 }, { kind: 'buc_throttled', delivery: 'none', status: 429, code: 80002 }],
    ];
    for (const [fault, expected] of cases) {
      await meta.fault({ ...fault, match: { path: '/v23.0/1784/messages' } });
      await assert.rejects(send, (err) => {
        for (const [key, value] of Object.entries(expected)) assert.equal(err[key], value, `${JSON.stringify(fault)} ${key}`);
        return true;
      });
    }
  });
});

test('Graph\'s codes map to what the compliance engine needs', () => {
  const kind = (status, code, subcode) => classifyGraphError({ status, code, subcode });
  assert.equal(kind(400, 190, 463), 'token_invalid');
  assert.equal(kind(400, 100), 'validation');
  assert.equal(kind(400, 100, 33), 'not_found');
  assert.equal(kind(400, 10, 2534022), 'window_closed');
  assert.equal(kind(400, 551, 1545041), 'recipient_unavailable');
  assert.equal(kind(400, 10900), 'already_replied');
  assert.equal(kind(400, 10901), 'reply_window_closed');
  assert.equal(kind(400, 200), 'permission');
  for (const code of [4, 17, 32, 613]) assert.equal(kind(400, code), 'throttled', String(code));
  assert.equal(kind(503, 1), 'server_error');
});

test('a plain-text fallback is offered only when Meta refused the content', async () => {
  await withSim(async (meta, token) => {
    const client = createMetaClient({ graphBaseUrl: meta.url });
    const sender = client.sender(account('1784', token));
    await meta.post('/messages', { igUserId: '1784', from: '42', text: 'hi' });
    await assert.rejects(() => sender.dm('42', { text: 'x'.repeat(1001) }), (err) => err.canFallback === true && err.delivery === 'none');
    await meta.fault({ kind: 'server_error' });
    await assert.rejects(() => sender.dm('42', { text: 'ok' }), (err) => err.canFallback === false);
  });
});

test('a token goes in a header, never in the address, and no error carries it', async () => {
  await withSim(async (meta, token) => {
    const client = createMetaClient({ graphBaseUrl: meta.url });
    await client.forAccount(account('1784', token)).getAccount();
    await meta.post('/messages', { igUserId: '1784', from: '42', text: 'hi', deliver: false });
    await client.sender(account('1784', token)).dm('42', { text: 'hello' });
    for (const call of await meta.calls()) {
      assert.doesNotMatch(`${call.path}?${new URLSearchParams(call.query)}`, new RegExp(token));
      assert.equal(call.headers.authorization, `Bearer ${token}`);
    }
    await assert.rejects(() => client.forAccount(account('1784', 'wrong-token-value')).getAccount(), (err) => !err.message.includes('wrong-token-value') && err.kind === 'token_invalid');
  });
});

test('a redirect is never followed', async () => {
  let reached = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/landed')) reached++;
    res.writeHead(req.url.startsWith('/landed') ? 200 : 302, { location: '/landed', 'content-type': 'application/json' });
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const client = createMetaClient({ graphBaseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(() => client.forAccount(account('1', 't')).getAccount(), (err) => err.delivery === 'unknown');
    assert.equal(reached, 0);
  } finally {
    server.close();
  }
});

test('an account with no token cannot be used, and accounts never share one', async () => {
  const client = createMetaClient({ graphBaseUrl: 'http://127.0.0.1:9' });
  assert.throws(() => client.forAccount({ igUserId: '1', token: '' }), /no access token/);
  assert.throws(() => client.sender(null), /no access token/);
  await withSim(async (meta, token) => {
    const other = await meta.post('/accounts', { igUserId: '1785', username: 'other' });
    const live = createMetaClient({ graphBaseUrl: meta.url });
    assert.equal((await live.forAccount(account('1784', token)).getAccount()).username, 'shop');
    assert.equal((await live.forAccount(account('1785', other.token)).getAccount()).username, 'other');
    await assert.rejects(() => live.forAccount(account('1785', token)).listMedia(), (err) => err.kind === 'not_found');
  });
});

test('the usage header is read, and every call is reported with numbers only', async () => {
  assert.deepEqual(parseUsage(JSON.stringify({ 1: [{ call_count: 12, total_cputime: 78, total_time: 40, estimated_time_to_regain_access: 5 }] })), { percent: 78, regainMinutes: 5 });
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage('not json'), null);
  await withSim(async (meta, token) => {
    const seen = [];
    await meta.post('/usage', { igUserId: '1784', percent: 78 });
    const client = createMetaClient({ graphBaseUrl: meta.url }, { onCall: (info) => seen.push(info) });
    await client.forAccount(account('1784', token)).listMedia();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 200);
    assert.equal(seen[0].usage.percent, 78);
    assert.doesNotMatch(JSON.stringify(seen[0]), new RegExp(token));
  });
});

test('an observer that throws cannot change a call', async () => {
  await withSim(async (meta, token) => {
    const client = createMetaClient({ graphBaseUrl: meta.url }, { onCall: () => { throw new Error('boom'); } });
    assert.equal((await client.forAccount(account('1784', token)).getAccount()).username, 'shop');
  });
});

test('a message is put in Meta\'s format with nothing cut', () => {
  const long = 'त'.repeat(700);
  assert.deepEqual(wireMessage({ text: long }), { text: long });
  const button = wireMessage({ text: long, button: { url: 'https://a.test', title: 'A title much longer than twenty' } });
  assert.equal(button.attachment.payload.text, long);
  assert.deepEqual(button.attachment.payload.buttons, [{ type: 'web_url', url: 'https://a.test', title: 'A title much longer than twenty' }]);
  assert.deepEqual(wireMessage({ text: 'x', button: { payload: 'tap:1', title: 'Send me the link' } }).attachment.payload.buttons, [{ type: 'postback', payload: 'tap:1', title: 'Send me the link' }]);
  assert.deepEqual(wireMessage({ text: 'x', quickReplies: [{ title: 'Yes', payload: 'y' }] }).quick_replies, [{ content_type: 'text', title: 'Yes', payload: 'y' }]);
});

test('webhook signatures: right bytes pass, and anything odd is simply false', () => {
  const body = Buffer.from('{"a":1}');
  const good = `sha256=${crypto.createHmac('sha256', 's3').update(body).digest('hex')}`;
  assert.equal(verifyHubSignature(body, good, 's3'), true);
  assert.equal(verifyHubSignature(Buffer.from('{"a":2}'), good, 's3'), false);
  assert.equal(verifyHubSignature(body, good, ''), false);
  assert.equal(verifyHubSignature(undefined, good, 's3'), false);
  assert.equal(verifyHubSignature(body, undefined, 's3'), false);
  assert.equal(verifyHubSignature(body, `sha256=${'é'.repeat(64)}`, 's3'), false);
  assert.equal(verifyHubSignature(body, 'md5=abc', 's3'), false);
});

test('signed_request: a valid one gives its payload, a forged or malformed one gives null', () => {
  const signed = signedRequest({ algorithm: 'HMAC-SHA256', user_id: '42' }, 's3');
  assert.equal(verifySignedRequest(signed, 's3').user_id, '42');
  assert.equal(verifySignedRequest(signed, 'other'), null);
  assert.equal(verifySignedRequest(signedRequest({ algorithm: 'NONE', user_id: '42' }, 's3'), 's3'), null);
  for (const bad of [undefined, '', 'x', 'a.b.c', `é.${signed.split('.')[1]}`, `${signed.split('.')[0]}.`]) {
    assert.equal(verifySignedRequest(bad, 's3'), null, String(bad));
  }
});
