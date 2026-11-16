// D-7, the same cause elsewhere: an ice breaker's answer is a message a buyer gets (PRD 6.4), so a link written in it is held to the
// link rules at save (PRD 4.11) as an automation's messages are, not left for the send gate to hold after it is live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, refused, withApp } from '../../p0/admin-api/support.js';

const save = (app, items) => app.api('PUT', '/ice-breakers', { items });

test('D-7: an ice breaker whose answer or question carries a shortener, a blocked host or a stranger\'s WhatsApp is refused at save', withApp(async (app) => {
  await app.db.platform.query(`INSERT INTO link_blocked_hosts (host, category) VALUES ('evil.example', 'malware') ON CONFLICT DO NOTHING`);
  for (const [items, reason, field] of [
    [[{ question: 'Do you ship?', templateBody: 'Track it at bit.ly/x' }], 'link.shortener', 'items.0'],
    [[{ question: 'Sizes?', templateBody: 'See the chart' }, { question: 'Offers?', templateBody: 'Read https://evil.example/offer' }], 'link.blocked', 'items.1'],
    [[{ question: 'Chat?', templateBody: 'Message wa.me/911111111111' }], 'link.not_allowlisted', 'items.0'],
    [[{ question: 'Where is tinyurl.com/abc?', templateBody: 'Here' }], 'link.shortener', 'items.0'],
  ]) {
    const res = await refused(await save(app, items), 400, 'validation_failed');
    assert.equal(res.reason, reason, JSON.stringify(items));
    assert.ok(Object.keys(res.fields ?? {}).includes(field), JSON.stringify(res.fields));
  }
  assert.deepEqual((await ok(await app.api('GET', '/ice-breakers'))).items, [], 'nothing was saved');
}));
