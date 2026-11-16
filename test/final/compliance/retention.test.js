// compliance-8: PRD 4.14 keeps message text 30 days. A sent message's text lives in outbound_jobs.payload and its recipient's id
// in recipient_id, so the retention sweep clears both on finished jobs older than that, and keeps what dedupe and the log need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, inWorld } from '../../p1/automations/support.js';

async function job(w, { status, ageDays, key, text = 'Hi Asha, here is your link https://shop.example/p' }) {
  const [row] = await w.db.platform.query(
    `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, purpose, idempotency_key, status, recipient_id, subject_hash, payload, expires_at, run_at, created_at, updated_at)
     VALUES ($1, 'instagram', $2, 'dm', 'manual', $3, $4, 'IGSID-PERSON-1', 'subject-hash', $5::jsonb, now() + interval '1 day', now(), now() - make_interval(days => $6), now() - make_interval(days => $6))
     RETURNING id`,
    [w.tenant.id, ACCOUNT, key, status, JSON.stringify({ message: { text }, fallbackText: `${text} (fallback)`, trigger: 'dm_keyword', inReplyTo: 'mid-1' }), ageDays],
  );
  return row.id;
}
const row = async (w, id) => (await w.db.platform.query('SELECT status, idempotency_key, recipient_id, subject_hash, payload FROM outbound_jobs WHERE id = $1', [id]))[0];

test('compliance-8: retention clears the text and recipient of finished jobs past 30 days, and nothing else', inWorld(async (w) => {
  const oldSent = await job(w, { status: 'sent', ageDays: 31, key: 'k-old-sent' });
  const oldFailed = await job(w, { status: 'failed', ageDays: 45, key: 'k-old-failed' });
  const oldHeld = await job(w, { status: 'held', ageDays: 31, key: 'k-old-held' });
  const fresh = await job(w, { status: 'sent', ageDays: 29, key: 'k-fresh' });

  await w.engine.housekeeping({ retention: true });

  for (const id of [oldSent, oldFailed]) {
    const after = await row(w, id);
    assert.equal(after.recipient_id, '', 'no person id after 30 days');
    assert.equal(after.payload.message, undefined, 'no message text after 30 days');
    assert.equal(after.payload.fallbackText, undefined);
    assert.doesNotMatch(JSON.stringify(after), /Asha|IGSID-PERSON/);
    assert.deepEqual([after.payload.trigger, after.payload.inReplyTo, after.subject_hash], ['dm_keyword', 'mid-1', 'subject-hash'], 'what dedupe and the log read stays');
  }
  assert.equal((await row(w, oldSent)).idempotency_key, 'k-old-sent');
  // A job that can still go keeps its message, and a newer one keeps everything.
  assert.match((await row(w, oldHeld)).payload.message.text, /Asha/);
  assert.equal((await row(w, fresh)).recipient_id, 'IGSID-PERSON-1');
  assert.match((await row(w, fresh)).payload.message.text, /Asha/);
}));
