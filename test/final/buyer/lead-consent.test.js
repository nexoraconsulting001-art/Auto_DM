// Final review D-15 (PRD 8.15, 9.18): the public lead form proves nobody owns the phone or email typed into it, so sending it
// again can never turn back on a channel the person withdrew. Withdrawal stops sends until the person's own verified step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from '../../p3/creator-leads/support.js';

const FILLED = { firstName: 'Asha', phone: '98765 43210', consent: 'yes', cv: '2', surface: 'landing' };
const send = (w, form) => w.page('/lead', { method: 'POST', form: { ...FILLED, ...form } });
const consentsOf = (w, leadId) => w.db.platform.query('SELECT channel, withdrawn_at FROM lead_consents WHERE lead_id = $1 ORDER BY channel', [leadId]);
const optOutLink = (text) => /href="(\/lead\/opt-out\?t=[\w.-]+)"/.exec(text)?.[1] ?? null;

test('D-15: an unverified resubmit keeps withdrawn channels withdrawn; only a channel the contact never had is added', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  assert.equal((await w.api('/lead-forms', { method: 'PATCH', body: { surface: 'landing', enabled: true } })).status, 200);
  assert.equal((await w.api('/lead-forms/consent', { method: 'PUT', body: { channels: ['whatsapp', 'sms', 'email'] } })).status, 200);

  // The person leaves their phone, then withdraws through their own link.
  const first = await send(w, { email: '' });
  assert.equal(first.status, 200);
  const token = new URLSearchParams(optOutLink(first.text).split('?')[1]).get('t');
  const [lead] = await w.db.platform.query('SELECT id FROM leads WHERE tenant_id = $1', [w.tenant.id]);
  assert.equal((await w.page('/lead/opt-out', { method: 'POST', form: { t: token, action: 'withdraw' } })).status, 200);
  assert.ok((await consentsOf(w, lead.id)).every((c) => c.withdrawn_at !== null));

  // Anyone can type that phone into the public form again, with an email the lead never had.
  const again = await send(w, { firstName: 'Someone', email: 'someone@example.com' });
  assert.equal(again.status, 200, 'the form answers as it always does, saying nothing about the contact');
  const after = await consentsOf(w, lead.id);
  assert.deepEqual(after.map((c) => [c.channel, c.withdrawn_at === null]), [['email', true], ['sms', false], ['whatsapp', false]],
    'a withdrawn WhatsApp or SMS consent was turned back on by an unverified send');
  const listed = (await w.api('/leads?consent=withdrawn')).body.items;
  assert.equal(listed.length, 1, 'the seller’s list still shows the withdrawal');
});
