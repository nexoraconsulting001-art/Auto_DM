-- Phase 1: the compliance engine's state (PRD 4). Everything here is per business, and per account where Meta's
-- limits are per account: no business ever uses another's budget, breaker or blocklist.

-- The only reason-code enum (PRD 4.16). src/contracts/compliance.js holds the same list and a test keeps them equal.
CREATE TABLE compliance_reason_codes (
  code   text PRIMARY KEY,
  family text NOT NULL CHECK (family IN ('outcome', 'intake', 'trigger', 'policy', 'cap', 'content', 'link', 'rate', 'pause', 'token', 'gate', 'data', 'addon'))
);
GRANT SELECT ON compliance_reason_codes TO bhava_app;

INSERT INTO compliance_reason_codes (code, family)
SELECT unnest(codes), family FROM (VALUES
  ('outcome', ARRAY['queued', 'held', 'sent', 'sent_fallback', 'unknown', 'failed', 'cancelled', 'expired', 'skipped', 'would_send']),
  ('intake', ARRAY['webhook.bad_signature', 'webhook.duplicate', 'webhook.malformed', 'tenant.unknown_entry', 'api.host_blocked']),
  ('trigger', ARRAY['unmapped', 'no_keyword', 'own_account', 'own_thread', 'unsupported_media', 'test_mode', 'automation.draft', 'outside_hours', 'too_short']),
  ('policy', ARRAY['optout', 'negative_intent', 'window.closed', 'expired.7d', 'expired.public_reply', 'followup.no_response', 'mention.no_window', 'tag.not_allowed', 'thread.handoff', 'thread.owner_replied', 'comment.deleted', 'comment.edited', 'recipient.unavailable']),
  ('cap', ARRAY['cap.per_comment', 'cap.per_media', 'cap.per_person_24h', 'cap.mention_7d', 'cap.followup', 'cap.welcome_once', 'cap.reply_per_message', 'cap.dm_replies_24h', 'cap.public_reply_media_h', 'cap.public_reply_tenant_h']),
  ('content', ARRAY['content.too_long', 'content.financial_request', 'content.button_title', 'content.bad_variable', 'content.bhava_promo']),
  ('link', ARRAY['link.scheme', 'link.shortener', 'link.not_allowlisted', 'link.redirect', 'link.blocked', 'link.check_failed']),
  ('rate', ARRAY['rate.throttled', 'rate.usage_header', 'rate.slow_mode', 'fallback.validation', 'send.unknown_outcome', 'send.error']),
  ('pause', ARRAY['paused.automation', 'paused.tenant', 'paused.global', 'paused.breaker', 'paused.reconnect', 'held.review', 'held.dm_limit', 'cancelled.owner', 'cancelled.optout']),
  ('token', ARRAY['token.refreshed', 'token.refresh_failed', 'token.rejected', 'token.deauthorized']),
  ('gate', ARRAY['gate.access_level', 'gate.scope_missing', 'gate.privacy_url', 'gate.deletion_callback', 'gate.passed']),
  ('data', ARRAY['deletion.requested', 'deletion.completed']),
  ('addon', ARRAY['ai.low_confidence', 'ai.ungrounded', 'wa.no_optin'])
) AS groups(family, codes);

-- The engine fills channel on every row and is held to the enum. These columns have no foreign keys: a key's
-- ON DELETE would have to rewrite a row of this insert-only table, and the log outlives what it describes.
ALTER TABLE compliance_events
  ADD COLUMN channel       text CHECK (channel IN ('instagram', 'facebook', 'whatsapp')),
  ADD COLUMN automation_id integer,
  ADD COLUMN job_id        bigint,
  ADD COLUMN media_id      text NOT NULL DEFAULT '',
  ADD COLUMN comment_id    text NOT NULL DEFAULT '';
CREATE INDEX compliance_events_comment_idx ON compliance_events (tenant_id, comment_id) WHERE comment_id <> '';
CREATE INDEX compliance_events_subject_idx ON compliance_events (tenant_id, subject, created_at) WHERE subject <> '';
CREATE INDEX compliance_events_reason_idx ON compliance_events (tenant_id, channel, reason, created_at);

CREATE FUNCTION check_compliance_codes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM compliance_reason_codes WHERE code = NEW.decision)
    OR (NEW.reason <> '' AND NOT EXISTS (SELECT 1 FROM compliance_reason_codes WHERE code = NEW.reason))
  ) THEN
    RAISE EXCEPTION 'compliance_events: % / % is not in the reason-code enum', NEW.decision, NEW.reason;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_events_codes BEFORE INSERT ON compliance_events
  FOR EACH ROW EXECUTE FUNCTION check_compliance_codes();

-- One row per business. subject_salt keys the HMAC of a person's id, so a hash means nothing in another business.
CREATE TABLE compliance_settings (
  tenant_id               integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  subject_salt            text NOT NULL,
  paused                  boolean NOT NULL DEFAULT false,
  paused_by               text CHECK (paused_by IN ('owner', 'ops', 'billing')),
  pause_reason            text NOT NULL DEFAULT '',
  paused_at               timestamptz,
  pause_store             boolean NOT NULL DEFAULT false,
  dry_run                 boolean NOT NULL DEFAULT false,
  disclosure_enabled      boolean NOT NULL DEFAULT false,
  utm_enabled             boolean NOT NULL DEFAULT true,
  cap_overrides           jsonb NOT NULL DEFAULT '{}',                  -- owners may only lower a cap; the engine enforces it
  score                   numeric(6, 2),                                -- opt-outs, negatives and errors per 1,000 sends
  score_at                timestamptz,
  score_review_needed     boolean NOT NULL DEFAULT false,
  access_level            text NOT NULL DEFAULT 'standard' CHECK (access_level IN ('standard', 'advanced')),
  app_role_ok             boolean NOT NULL DEFAULT false,
  privacy_url_ok_at       timestamptz,
  deletion_callback_ok_at timestamptz,
  gate_passed_at          timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('compliance_settings', 'SELECT, INSERT, UPDATE');

-- Switches about every business: no tenant_id. Business code reads them; only platform code changes them.
CREATE TABLE platform_switches (
  key                  text PRIMARY KEY CHECK (key IN ('global_kill', 'activations_frozen')),
  engaged              boolean NOT NULL DEFAULT false,
  reason               text NOT NULL DEFAULT '',
  engaged_by           text NOT NULL DEFAULT '',
  engaged_at           timestamptz,
  release_requested_by text NOT NULL DEFAULT '',
  release_requested_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_switches (key) VALUES ('global_kill'), ('activations_frozen');
GRANT SELECT ON platform_switches TO bhava_app;

-- PRD 4.12. A Facebook problem pauses only Facebook, so a breaker is per business and channel.
CREATE TABLE breakers (
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  state           text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  trip_reason     text NOT NULL DEFAULT '',
  opened_at       timestamptz,
  open_until      timestamptz,
  wait_minutes    integer NOT NULL DEFAULT 30 CHECK (wait_minutes > 0),
  reduced_until   timestamptz,                                          -- x0.5 for 15 min after a successful probe
  throttle_cycles integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);
CREATE INDEX breakers_opened_idx ON breakers (opened_at) WHERE state <> 'closed';
SELECT fence_tenant_table('breakers');

-- PRD 4.3: what Meta's answers have done to one account's sending.
CREATE TABLE account_rate_state (
  tenant_id              integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel                text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  account_id             text NOT NULL,
  messaging_paused_until timestamptz,
  backoff_minutes        integer NOT NULL DEFAULT 0 CHECK (backoff_minutes >= 0),
  other_paused_until     timestamptz,
  usage_percent          integer,
  usage_at               timestamptz,
  slow_mode_started_at   timestamptz,
  slow_mode_until        timestamptz,
  slow_mode_trigger      text CHECK (slow_mode_trigger IN ('reach_drop', 'buc_80002', 'insights_denied')),
  slow_mode_override_at  timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, account_id)
);
SELECT fence_tenant_table('account_rate_state');

-- One token bucket per account and budget. Business-level public-reply caps are counted from cap_claims.
CREATE TABLE send_budgets (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  account_id  text NOT NULL,
  budget      text NOT NULL CHECK (budget IN ('private_reply', 'send_api', 'conversations', 'buc')),
  tokens      double precision NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, account_id, budget)
);
SELECT fence_tenant_table('send_budgets');

-- Webhooks are stored here before the 200 goes back (PRD 4.1), and a worker processes them. object_id is the comment
-- id or message id; a later event about the same object (an edit) carries its own key, such as "<id>:edited".
CREATE TABLE inbound_events (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  account_id   text NOT NULL,
  field        text NOT NULL,
  object_id    text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'stored' CHECK (status IN ('stored', 'processing', 'done', 'failed', 'malformed')),
  attempts     integer NOT NULL DEFAULT 0,
  lease_until  timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, channel, field, object_id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX inbound_events_ready_idx ON inbound_events (received_at) WHERE status = 'stored';
CREATE INDEX inbound_events_lease_idx ON inbound_events (lease_until) WHERE status = 'processing';
CREATE INDEX inbound_events_retention_idx ON inbound_events (received_at);
SELECT fence_tenant_table('inbound_events');

-- Webhooks for an account no business owns: the account id and nothing else (PRD 4.1). Platform only, so no grant.
CREATE TABLE inbound_unrouted (
  channel       text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  account_id    text NOT NULL,
  deliveries    integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, account_id)
);
