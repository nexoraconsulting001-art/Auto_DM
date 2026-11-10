import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createSim, reply, SimError } from '../../../tools/sim/base.mjs';
import { request } from './support.js';

/** A small service: POST /things stores one, GET /things lists them. Shows what took effect. */
async function startThings(t) {
  const things = [];
  const sim = createSim({
    name: 'things',
    reset: () => things.splice(0),
    routes: (on) => {
      on('POST', '/things', (req) => {
        if (!req.body?.name) throw new SimError(422, { error: 'name is required' });
        things.push(req.body.name);
        return { id: things.length };
      });
      on('GET', '/things', () => ({ things }));
      on('GET', '/things/:id/parts', (req) => ({ id: req.params.id }));
      on('GET', '/teapot', () => reply(418, 'short and stout', { 'x-kind': 'teapot' }));
    },
    controls: (on) => {
      on('GET', '/count', () => ({ count: things.length }));
    },
  });
  await sim.start();
  t.after(() => sim.close());
  return { sim, things, post: (name = 'a') => request(`${sim.url}/things`, { json: { name } }) };
}

test('a simulator listens on 127.0.0.1 only and answers its routes', async (t) => {
  const { sim, things, post } = await startThings(t);
  assert.match(sim.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const res = await post('one');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 1 });
  assert.deepEqual(things, ['one']);
  assert.deepEqual((await request(`${sim.url}/things/a%2Fb/parts`)).body, { id: 'a/b' });
  const teapot = await request(`${sim.url}/teapot`);
  assert.equal(teapot.status, 418);
  assert.equal(teapot.text, 'short and stout');
  assert.equal(teapot.headers.get('x-kind'), 'teapot');
  assert.equal((await request(`${sim.url}/nope`)).status, 404);
  assert.deepEqual((await request(`${sim.url}/__sim/health`)).body, { ok: true, name: 'things' });
});

test('a request from a page on a public name is refused', async (t) => {
  const { sim } = await startThings(t);
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect(sim.port, '127.0.0.1', () => socket.write('GET /__sim/health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'));
    let text = '';
    socket.on('data', (d) => (text += d));
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
    socket.on('error', reject);
  });
  assert.equal(status, 403);
});

test('calls records requests in order, with status, and can be filtered and cleared; control routes are not recorded', async (t) => {
  const { sim, post } = await startThings(t);
  await post('a');
  await request(`${sim.url}/things?x=1`);
  await request(`${sim.url}/__sim/faults`);
  const { calls } = await (await request(`${sim.url}/__sim/calls`)).body;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => [c.seq, c.method, c.path, c.status, c.applied]), [[1, 'POST', '/things', 200, true], [2, 'GET', '/things', 200, true]]);
  assert.deepEqual(calls[0].body, { name: 'a' });
  assert.deepEqual(calls[1].query, { x: '1' });
  assert.deepEqual(calls[0].response, { id: 1 });

  assert.equal((await sim.calls({ method: 'post' })).length, 1);
  assert.equal((await sim.calls({ path: '/thi*' })).length, 2);
  assert.equal((await sim.calls({ path: '/other' })).length, 0);
  assert.equal((await sim.calls({ since: '1' })).length, 1);

  await request(`${sim.url}/__sim/calls`, { method: 'DELETE' });
  assert.deepEqual(await sim.calls(), []);
});

test('a refused request is recorded as not applied', async (t) => {
  const { sim } = await startThings(t);
  assert.equal((await request(`${sim.url}/things`, { json: {} })).status, 422);
  const [call] = await sim.calls();
  assert.equal(call.status, 422);
  assert.equal(call.applied, false);
});

test('timeout: never answers, nothing takes effect, and the client decides when to give up', async (t) => {
  const { sim, things, post } = await startThings(t);
  await sim.fault({ kind: 'timeout' });
  const res = await request(`${sim.url}/things`, { json: { name: 'a' }, signal: AbortSignal.timeout(150) });
  assert.equal(res.status, null);
  assert.equal(res.error.name, 'TimeoutError');
  assert.deepEqual(things, []);
  const [call] = await sim.calls();
  assert.equal(call.status, null);
  assert.deepEqual(call.fault.kind, 'timeout');
  assert.equal(call.applied, false);
  assert.equal((await post('b')).status, 200, 'the next request is not faulted');
});

test('timeout with delayMs drops the connection after that long', async (t) => {
  const { sim } = await startThings(t);
  await sim.fault({ kind: 'timeout', delayMs: 30 });
  const started = Date.now();
  const res = await request(`${sim.url}/things`);
  assert.equal(res.status, null);
  assert.ok(Date.now() - started >= 25);
});

test('a held request does not stop the simulator closing', async (t) => {
  const { sim } = await startThings(t);
  await sim.fault({ kind: 'timeout' });
  const pending = request(`${sim.url}/things`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await sim.close();
  assert.equal((await pending).status, null);
});

test('rate_limit: 429 by default, with Retry-After when asked', async (t) => {
  const { sim, things, post } = await startThings(t);
  await sim.fault({ kind: 'rate_limit', retryAfter: 30 });
  const res = await post();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.equal(res.body.error.code, 'rate_limit');
  assert.deepEqual(things, []);
});

test('server_error: 500 by default, any 5xx on request', async (t) => {
  const { sim, things, post } = await startThings(t);
  await sim.fault({ kind: 'server_error' });
  assert.equal((await post()).status, 500);
  await sim.fault({ kind: 'server_error', status: 503 });
  assert.equal((await post()).status, 503);
  assert.deepEqual(things, []);
});

test('malformed: each mode returns a body a JSON parser cannot use as expected', async (t) => {
  const { sim, post } = await startThings(t);
  for (const mode of ['truncated', 'garbage', 'html']) {
    await sim.fault({ kind: 'malformed', mode });
    const res = await post();
    assert.equal(res.status, 200, mode);
    assert.equal(res.body, null, `${mode} must not parse`);
    assert.ok(res.text.length > 0, mode);
  }
  await sim.fault({ kind: 'malformed', mode: 'empty' });
  assert.equal((await post()).text, '');
  await sim.fault({ kind: 'malformed', mode: 'wrong_shape' });
  assert.deepEqual((await post()).body, [1, 2, 3]);
  await sim.fault({ kind: 'malformed', mode: 'aborted' });
  const aborted = await post();
  assert.equal(aborted.status, null, 'half a body then a dead socket fails the read');
});

test('drop: the connection resets and nothing takes effect', async (t) => {
  const { sim, things, post } = await startThings(t);
  await sim.fault({ kind: 'drop' });
  assert.equal((await post()).status, null);
  assert.deepEqual(things, []);
});

test('partial: the request takes effect, then the answer fails', async (t) => {
  const { sim, things, post } = await startThings(t);
  await sim.fault({ kind: 'partial' });
  assert.equal((await post('one')).status, 500);
  assert.deepEqual(things, ['one'], 'applied even though the caller saw a 500');
  const [call] = await sim.calls();
  assert.equal(call.applied, true);
  assert.equal(call.fault.kind, 'partial');

  await sim.fault({ kind: 'partial', then: 'drop' });
  assert.equal((await post('two')).status, null);
  await sim.fault({ kind: 'partial', then: 'malformed', mode: 'garbage' });
  assert.equal((await post('three')).body, null);
  await sim.fault({ kind: 'partial', then: 'timeout', delayMs: 10 });
  assert.equal((await post('four')).status, null);
  assert.deepEqual(things, ['one', 'two', 'three', 'four']);
});

test('partial can answer exactly what a test needs', async (t) => {
  const { sim, things, post } = await startThings(t);
  await sim.fault({ kind: 'partial', status: 207, body: { created: 1, failed: 1 } });
  const res = await post('one');
  assert.equal(res.status, 207);
  assert.deepEqual(res.body, { created: 1, failed: 1 });
  assert.deepEqual(things, ['one']);
});

test('a partial whose handler refuses is recorded as not applied', async (t) => {
  const { sim } = await startThings(t);
  await sim.fault({ kind: 'partial' });
  await request(`${sim.url}/things`, { json: {} });
  const [call] = await sim.calls();
  assert.equal(call.applied, false);
  assert.equal(call.handled.status, 422);
});

test('times and after decide which matching requests fail', async (t) => {
  const { sim, post } = await startThings(t);
  await sim.fault({ kind: 'server_error', times: 2, after: 1 });
  assert.deepEqual([(await post()).status, (await post()).status, (await post()).status, (await post()).status], [200, 500, 500, 200]);
  assert.deepEqual((await sim.get('/faults')).faults, [], 'a used-up fault is gone');

  await sim.fault({ kind: 'server_error', times: 'forever' });
  assert.deepEqual([(await post()).status, (await post()).status], [500, 500]);
  await sim.delete('/faults');
  assert.equal((await post()).status, 200);
});

test('racing requests each use up their own firing', async (t) => {
  const { sim, post } = await startThings(t);
  await sim.fault({ kind: 'server_error', times: 3 });
  const statuses = (await Promise.all(Array.from({ length: 5 }, () => post()))).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 500, 500, 500]);
});

test('match narrows a fault by method, path, query and body', async (t) => {
  const { sim, post } = await startThings(t);
  const { id } = await sim.fault({ kind: 'server_error', match: { method: 'get', path: '/thi*' }, times: 'forever' });
  assert.equal((await post()).status, 200);
  assert.equal((await request(`${sim.url}/things`)).status, 500);
  await sim.delete(`/faults/${id}`);

  await sim.fault({ kind: 'server_error', match: { body: { name: 'bad' } }, times: 'forever' });
  await sim.fault({ kind: 'rate_limit', match: { query: { retry: '*' } }, times: 'forever' });
  assert.equal((await post('good')).status, 200);
  assert.equal((await post('bad')).status, 500);
  assert.equal((await request(`${sim.url}/things?other=1`)).status, 200);
  assert.equal((await request(`${sim.url}/things?retry=2`)).status, 429);
});

test('a fault that matches nothing is left waiting', async (t) => {
  const { sim, post } = await startThings(t);
  await sim.fault({ kind: 'server_error', match: { path: '/elsewhere' } });
  assert.equal((await post()).status, 200);
  assert.equal((await sim.get('/faults')).faults.length, 1);
});

test('a mistyped fault is refused, not ignored', async (t) => {
  const { sim } = await startThings(t);
  const url = `${sim.url}/__sim/faults`;
  for (const bad of [{ kind: 'boom' }, {}, { kind: 'timeout', time: 3 }, { kind: 'timeout', times: 0 }, { kind: 'timeout', times: 'always' }, { kind: 'timeout', after: -1 }, { kind: 'timeout', match: 'x' }, { kind: 'timeout', match: { paths: 'x' } }, { kind: 'server_error', status: 429 }, { kind: 'rate_limit', status: 500 }, { kind: 'malformed', mode: 'nope' }, { kind: 'partial', then: 'nope' }, { kind: 'timeout', delayMs: -1 }]) {
    assert.equal((await request(url, { json: bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await sim.get('/faults')).faults, []);
  assert.equal((await request(url, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`${url}/f999`, { method: 'DELETE' })).status, 404);
});

test('control routes are never faulted', async (t) => {
  const { sim } = await startThings(t);
  await sim.fault({ kind: 'drop', times: 'forever' });
  assert.equal((await request(`${sim.url}/__sim/health`)).status, 200);
});

test('a bad control body is a 400', async (t) => {
  const { sim } = await startThings(t);
  const url = `${sim.url}/__sim/faults`;
  assert.equal((await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
  assert.equal((await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' })).status, 400);
});

test('form, urlencoded and multipart bodies all reach the handler', async (t) => {
  const { sim, things } = await startThings(t);
  await request(`${sim.url}/things`, { method: 'POST', body: new URLSearchParams({ name: 'url' }) });
  const form = new FormData();
  form.set('name', 'multi');
  await request(`${sim.url}/things`, { method: 'POST', body: form });
  assert.deepEqual(things, ['url', 'multi']);
});

test('an oversized request gets 413', async (t) => {
  const { sim } = await startThings(t);
  const res = await request(`${sim.url}/things`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(6 * 1024 * 1024) });
  assert.ok(res.status === 413 || res.status === null, `got ${res.status}`);
});

test('the clock can be read, frozen, set and moved', async (t) => {
  const { sim } = await startThings(t);
  const before = Date.now();
  const running = (await sim.get('/clock'));
  assert.ok(running.now >= before && !running.frozen);
  assert.deepEqual(await sim.post('/clock', { freeze: true, now: 1000 }), { now: 1000, frozen: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await sim.get('/clock')).now, 1000, 'a frozen clock does not move');
  assert.equal((await sim.post('/clock', { advanceMs: 500 })).now, 1500);
  const thawed = await sim.post('/clock', { freeze: false });
  assert.equal(thawed.frozen, false);
  assert.ok(thawed.now >= 1500 && thawed.now < 2000);
  await assert.rejects(() => sim.post('/clock', { advanceMs: 'soon' }), /must be a number/);
  const unfrozenSet = await sim.post('/clock', { now: 5000 });
  assert.ok(unfrozenSet.now >= 5000 && unfrozenSet.now < 6000);
});

test('reset clears faults, calls, the clock and the service data', async (t) => {
  const { sim, things, post } = await startThings(t);
  await post('a');
  await sim.fault({ kind: 'drop', match: { path: '/other' } });
  await sim.post('/clock', { freeze: true, now: 1000 });
  await request(`${sim.url}/__sim/reset`, { method: 'POST' });
  assert.deepEqual(things, []);
  assert.deepEqual(await sim.calls(), []);
  assert.deepEqual((await sim.get('/faults')).faults, []);
  assert.equal((await sim.get('/clock')).frozen, false);
});

test('in-process control routes and a service-specific control work like HTTP ones', async (t) => {
  const { sim, post } = await startThings(t);
  await post('a');
  assert.deepEqual(await sim.get('/count'), { count: 1 });
  assert.deepEqual((await request(`${sim.url}/__sim/count`)).body, { count: 1 });
  await assert.rejects(() => sim.get('/nope'), SimError);
});

test('a handler bug is a 500 and does not stop the simulator', async (t) => {
  const sim = await createSim({ name: 'buggy', routes: (on) => on('GET', '/boom', () => { throw new TypeError('bad code'); }) }).start();
  t.after(() => sim.close());
  const writes = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => writes.push(String(chunk));
  t.after(() => { process.stderr.write = realWrite; });
  assert.equal((await request(`${sim.url}/boom`)).status, 500);
  process.stderr.write = realWrite;
  assert.equal((await request(`${sim.url}/__sim/health`)).status, 200);
  assert.match(writes.join(''), /bad code/);
});
