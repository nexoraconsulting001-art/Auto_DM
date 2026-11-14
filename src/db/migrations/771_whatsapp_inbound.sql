-- Phase 7: the WhatsApp add-on (PRD 6.12), what migration 770 left out.
--
-- 1. Embedded signup hands back a one-time state, kept the way the Instagram and Facebook connects keep theirs: only its
--    hash, for a few minutes, used once.
-- 2. A shopper's WhatsApp message is stored in inbound_events (channel 'whatsapp') before the webhook is answered, so a
--    repeat of the same message id is a no-op. Its own status 'pending' keeps it out of the Instagram and Facebook worker,
--    which only ever takes 'stored' rows: the WhatsApp add-on works it through and then marks it 'done' or 'failed'.

ALTER TABLE oauth_states DROP CONSTRAINT oauth_states_provider_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_provider_check CHECK (provider IN ('instagram', 'unified', 'facebook', 'whatsapp'));

ALTER TABLE inbound_events DROP CONSTRAINT inbound_events_status_check;
ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_status_check CHECK (status IN ('stored', 'processing', 'done', 'failed', 'malformed', 'pending'));
ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_pending_whatsapp CHECK (status <> 'pending' OR channel = 'whatsapp');
CREATE INDEX inbound_events_wa_pending_idx ON inbound_events (received_at) WHERE status = 'pending';
