-- Phase 1: the send queue, opt-outs and caps (PRD 4.3 to 4.7). The queue's idempotency key is per business: one
-- business's key can never drop another business's job.

CREATE TABLE outbound_jobs (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  ig_user_id      text,
  fb_page_id      text,
  kind            text NOT NULL CHECK (kind IN ('private_reply', 'dm', 'public_reply')),
  purpose         text NOT NULL DEFAULT 'trigger' CHECK (purpose IN ('trigger', 'link', 'followup', 'welcome', 'faq', 'optout_confirm', 'manual', 'test')),
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'held', 'sending', 'sent', 'sent_fallback', 'unknown', 'failed', 'cancelled', 'expired', 'skipped', 'would_send')),
  reason          text NOT NULL DEFAULT '',
  automation_id   integer,
  variant_id      integer,
  media_id        text NOT NULL DEFAULT '',
  comment_id      text NOT NULL DEFAULT '',
  recipient_id    text NOT NULL DEFAULT '',
  subject_hash    text NOT NULL DEFAULT '',
  payload         jsonb NOT NULL DEFAULT '{}',
  expires_at      timestamptz NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  locked_by       text,
  attempts        integer NOT NULL DEFAULT 0,
  token_version   integer,
  http_status     integer,
  meta_code       integer,
  meta_subcode    integer,
  message_id      text,
  is_test         boolean NOT NULL DEFAULT false,                       -- tester, test mode or dry run: never counted
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  CONSTRAINT outbound_jobs_one_account CHECK (
    (channel = 'instagram' AND ig_user_id IS NOT NULL AND fb_page_id IS NULL)
    OR (channel = 'facebook' AND fb_page_id IS NOT NULL AND ig_user_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, ig_user_id) REFERENCES ig_accounts(tenant_id, ig_user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, fb_page_id) REFERENCES fb_pages(tenant_id, page_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations(tenant_id, id) ON DELETE SET NULL (automation_id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES template_variants(tenant_id, id) ON DELETE SET NULL (variant_id)
);
CREATE INDEX outbound_jobs_ready_idx ON outbound_jobs (run_at) WHERE status = 'queued';
CREATE INDEX outbound_jobs_lease_idx ON outbound_jobs (lease_until) WHERE status = 'sending';
CREATE INDEX outbound_jobs_status_idx ON outbound_jobs (tenant_id, status, created_at);
CREATE INDEX outbound_jobs_ig_sent_idx ON outbound_jobs (tenant_id, ig_user_id, kind, sent_at);
CREATE INDEX outbound_jobs_fb_sent_idx ON outbound_jobs (tenant_id, fb_page_id, kind, sent_at);
CREATE INDEX outbound_jobs_automation_idx ON outbound_jobs (tenant_id, automation_id);
CREATE INDEX outbound_jobs_variant_idx ON outbound_jobs (tenant_id, variant_id);
CREATE INDEX outbound_jobs_subject_idx ON outbound_jobs (tenant_id, channel, subject_hash, status);
CREATE INDEX outbound_jobs_comment_idx ON outbound_jobs (tenant_id, comment_id) WHERE comment_id <> '';
CREATE UNIQUE INDEX outbound_jobs_message_idx ON outbound_jobs (tenant_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX outbound_jobs_expiry_idx ON outbound_jobs (expires_at) WHERE status IN ('queued', 'held');
SELECT fence_tenant_table('outbound_jobs');

-- PRD 4.6: the person's id as a salted hash (compliance_settings.subject_salt), per business and channel.
CREATE TABLE opt_outs (
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  subject_hash text NOT NULL,
  source       text NOT NULL CHECK (source IN ('dm', 'comment', 'send_error', 'ops')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, subject_hash)
);
SELECT fence_tenant_table('opt_outs');

-- PRD 4.7: a claim is inserted in the transaction that creates the job. Caps once per something have a scope_key
-- (the comment, media, message or automation) and the unique index makes the insert atomic. Rolling caps
-- (cap.per_person_24h, cap.dm_replies_24h, cap.mention_7d, public-reply caps) use scope_key '' and count by
-- claimed_at, under pg_advisory_xact_lock on the person or the business so that two transactions can't both pass.
CREATE TABLE cap_claims (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  cap           text NOT NULL CHECK (cap IN ('cap.per_comment', 'cap.per_media', 'cap.per_person_24h', 'cap.mention_7d', 'cap.followup', 'cap.welcome_once', 'cap.reply_per_message', 'cap.dm_replies_24h', 'cap.public_reply_media_h', 'cap.public_reply_tenant_h')),
  subject_hash  text NOT NULL DEFAULT '',
  scope_key     text NOT NULL DEFAULT '',
  automation_id integer,
  job_id        bigint,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations(tenant_id, id) ON DELETE SET NULL (automation_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES outbound_jobs(tenant_id, id) ON DELETE SET NULL (job_id)
);
CREATE UNIQUE INDEX cap_claims_once_idx ON cap_claims (tenant_id, channel, cap, subject_hash, scope_key) WHERE scope_key <> '';
CREATE INDEX cap_claims_window_idx ON cap_claims (tenant_id, channel, cap, subject_hash, claimed_at);
CREATE INDEX cap_claims_automation_idx ON cap_claims (tenant_id, automation_id);
CREATE INDEX cap_claims_job_idx ON cap_claims (tenant_id, job_id);
CREATE INDEX cap_claims_expiry_idx ON cap_claims (expires_at) WHERE expires_at IS NOT NULL;
SELECT fence_tenant_table('cap_claims');

-- Words a business adds to Bhava's lists (PRD 4.6, 4.8, 6.4). The base lists are in code and can't be removed.
CREATE TABLE tenant_words (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list       text NOT NULL CHECK (list IN ('optout', 'negative', 'handoff')),
  word       text NOT NULL,
  normalized text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, list, normalized)
);
SELECT fence_tenant_table('tenant_words');
