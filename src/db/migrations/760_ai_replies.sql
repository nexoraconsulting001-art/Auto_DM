-- Phase 7: the AI replies add-on (PRD 6.11). Answers come only from a business's own FAQ entries and catalog, go out
-- only through the compliance gate, and every decision is logged. Nothing here is shared between businesses.

-- The questions a business has answered itself. The only free text an AI reply may draw on, beside the catalog.
CREATE TABLE faq_entries (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question   text NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  answer     text NOT NULL CHECK (length(answer) BETWEEN 1 AND 1000),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX faq_entries_list_idx ON faq_entries (tenant_id, active, id);
SELECT fence_tenant_table('faq_entries');

-- One row per business. Off until the owner turns it on, and it cannot be on with no active FAQ entry.
CREATE TABLE ai_settings (
  tenant_id  integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT false,
  -- A draft scoring below this is not sent (ai.low_confidence).
  threshold  numeric(3,2) NOT NULL DEFAULT 0.80 CHECK (threshold >= 0.50 AND threshold <= 1.00),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('ai_settings');

CREATE FUNCTION ai_settings_needs_faq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled AND NOT EXISTS (SELECT 1 FROM faq_entries WHERE tenant_id = NEW.tenant_id AND active) THEN
    RAISE EXCEPTION 'AI replies need at least one FAQ entry' USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_settings_needs_faq';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_settings_needs_faq BEFORE INSERT OR UPDATE ON ai_settings FOR EACH ROW EXECUTE FUNCTION ai_settings_needs_faq();

-- Removing or switching off the last entry turns AI replies off with it.
CREATE FUNCTION faq_entries_last_one() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM faq_entries WHERE tenant_id = OLD.tenant_id AND active) THEN
    UPDATE ai_settings SET enabled = false, updated_at = now() WHERE tenant_id = OLD.tenant_id AND enabled;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER faq_entries_last_one AFTER UPDATE OF active OR DELETE ON faq_entries FOR EACH ROW EXECUTE FUNCTION faq_entries_last_one();

INSERT INTO compliance_reason_codes (code, family) VALUES ('ai.handoff', 'addon'), ('ai.provider_failed', 'addon');

-- An AI reply is its own purpose, and it is the one automated reply to the inbound DM it answers (cap.reply_per_message).
ALTER TABLE outbound_jobs DROP CONSTRAINT outbound_jobs_purpose_check;
ALTER TABLE outbound_jobs ADD CONSTRAINT outbound_jobs_purpose_check
  CHECK (purpose IN ('trigger', 'link', 'followup', 'welcome', 'faq', 'optout_confirm', 'manual', 'test', 'ai_reply'));

-- One row per decision about an inbound DM, and one per test question (inbound_mid ''). question and answer follow the
-- inbox retention rule (30 days, PRD 4.14): housekeeping blanks them and keeps the rest of the row.
CREATE TABLE ai_reply_log (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('instagram', 'facebook', 'whatsapp')),
  thread_id   integer,
  inbound_mid text NOT NULL DEFAULT '' CHECK (length(inbound_mid) <= 400),
  job_id      bigint,
  question    text NOT NULL DEFAULT '' CHECK (length(question) <= 2000),
  answer      text NOT NULL DEFAULT '' CHECK (length(answer) <= 4000),
  -- 'faq:<id>' and 'product:<id>', as the provider named them.
  source_ids  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(source_ids) <= 20),
  score       numeric(4,3) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  threshold   numeric(3,2),
  model       text NOT NULL DEFAULT '' CHECK (length(model) <= 120),
  units       integer NOT NULL DEFAULT 0 CHECK (units >= 0),
  outcome     text NOT NULL CHECK (outcome IN ('answered', 'handed_off', 'dropped', 'failed', 'test')),
  -- A reason code, or NULL when there is nothing to explain.
  reason      text REFERENCES compliance_reason_codes(code),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (outcome <> 'test' OR (inbound_mid = '' AND job_id IS NULL)),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES inbox_threads(tenant_id, id) ON DELETE SET NULL (thread_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES outbound_jobs(tenant_id, id) ON DELETE SET NULL (job_id)
);
-- One decision per inbound DM, however many times the queue hands it over.
CREATE UNIQUE INDEX ai_reply_log_inbound_idx ON ai_reply_log (tenant_id, channel, inbound_mid) WHERE inbound_mid <> '';
CREATE INDEX ai_reply_log_list_idx ON ai_reply_log (tenant_id, created_at DESC, id DESC);
CREATE INDEX ai_reply_log_thread_idx ON ai_reply_log (tenant_id, thread_id);
CREATE INDEX ai_reply_log_job_idx ON ai_reply_log (tenant_id, job_id);
CREATE INDEX ai_reply_log_retention_idx ON ai_reply_log (created_at);
SELECT fence_tenant_table('ai_reply_log');
