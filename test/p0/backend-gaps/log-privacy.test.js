import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log, setLogSink } from '../../../src/platform/log.js';
import { REEL_ID, fakeIg, login, seedReel, startApp } from '../../helpers.js';
import { filesIn, repoRoot } from './support.js';

const defaultSink = (line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
const sign = (body) => `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;

test('nothing in src calls console', () => {
  const offenders = filesIn('src').filter((f) => f.endsWith('.js') && /\bconsole\s*\./.test(fs.readFileSync(path.join(repoRoot, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('a comment through the webhook leaves no username or message text in the logs', async () => {
  const lines = [];
  setLogSink((line) => lines.push(line));
  const app = await startApp({ ig: fakeIg({ failButton: true }) });
  try {
    await seedReel(app.repos, { n: 1 });
    await app.repos.reels.save(REEL_ID, { headline: 'Brunch', keywords: 'LINK', productIds: (await app.repos.products.list()).map((p) => p.id), active: 'on', public_reply: 'Sent!' });
    const value = { id: 'c1', text: 'LINK please PRIVATE-TEXT', media: { id: REEL_ID }, from: { id: 'u1', username: 'private_username' } };
    const body = JSON.stringify({ entry: [{ id: 'ME', changes: [{ field: 'comments', value }] }] });
    await fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    for (const end = Date.now() + 5000; !lines.some((l) => l.includes('webhook.comment')) && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));

    const all = lines.join('\n');
    assert.match(all, /dm\.sent/);
    assert.match(all, /dm\.button_rejected/);
    assert.match(all, /webhook\.comment/);
    for (const secret of ['private_username', 'PRIVATE-TEXT', 'Brunch', 'test-ig-token']) assert.ok(!all.includes(secret), secret);
  } finally {
    setLogSink(defaultSink);
    app.close();
  }
});

test('a failed request logs no phone number from the form', async () => {
  const lines = [];
  setLogSink((line) => lines.push(line));
  const app = await startApp();
  try {
    await fetch(`${app.base}/signup`, { method: 'POST', body: new URLSearchParams({ name: 'Asha', phone: '98765 43210', password: '1' }) });
    await login(app.base);
    assert.ok(!lines.join('\n').includes('43210'));
    assert.ok(!lines.join('\n').includes('9000000001'));
  } finally {
    setLogSink(defaultSink);
    app.close();
  }
});

test('the log module drops fields that would hold personal data', () => {
  const lines = [];
  setLogSink((line) => lines.push(JSON.parse(line)));
  try {
    log.info('x', { username: 'a', user_name: 'a', text: 'b', message: 'c', phone: 'd', email: 'e', password: 'f', token: 'g', accessToken: 'h', Authorization: 'i', comment: 'kept' });
    log.error('y', { text: 'b', err: new Error('boom') });
  } finally {
    setLogSink(defaultSink);
  }
  const { time: _t, level: _l, ...entry } = lines[0];
  assert.deepEqual(entry, { msg: 'x', comment: 'kept' });
  assert.equal(lines[1].err.message, 'boom');
  assert.equal('text' in lines[1], false);
});
