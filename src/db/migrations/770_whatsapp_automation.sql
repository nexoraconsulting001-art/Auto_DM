-- Phase 7: the WhatsApp add-on (PRD 6.12). WhatsApp becomes a channel of the compliance engine: the same queue, budgets,
-- opt-outs, caps, pauses and log as Instagram and Facebook, per phone number. It builds on whatsapp_accounts and
-- whatsapp_templates (409). A WhatsApp id is a phone number: it is kept only where a reply needs it (inbox_threads and
-- outbound_jobs, recipient_id) and everywhere else as the business's salted hash.

ALTER TABLE whatsapp_accounts
  ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 120),
  ADD CONSTRAINT whatsapp_accounts_tenant_phone_key UNIQUE (tenant_id, phone_number_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['breakers', 'account_rate_state', 'send_budgets', 'inbound_events', 'inbound_unrouted', 'outbound_jobs', 'opt_outs', 'cap_claims', 'inbox_threads', 'needs_human_items'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_channel_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (channel IN (%L, %L, %L))', t, t || '_channel_check', 'instagram', 'facebook', 'whatsapp');
  END LOOP;
END $$;

-- A job and a thread belong to exactly one account: an Instagram account, a Facebook Page or a WhatsApp number.
ALTER TABLE outbound_jobs
  ADD COLUMN wa_phone_number_id text,
  DROP CONSTRAINT outbound_jobs_one_account,
  ADD CONSTRAINT outbound_jobs_one_account CHECK (
    (channel = 'instagram' AND ig_user_id IS NOT NULL AND fb_page_id IS NULL AND wa_phone_number_id IS NULL)
    OR (channel = 'facebook' AND fb_page_id IS NOT NULL AND ig_user_id IS NULL AND wa_phone_number_id IS NULL)
    OR (channel = 'whatsapp' AND wa_phone_number_id IS NOT NULL AND ig_user_id IS NULL AND fb_page_id IS NULL)
  ),
  -- WhatsApp has no comments: only a message inside the window, or an approved template.
  ADD CONSTRAINT outbound_jobs_whatsapp_dm CHECK (channel <> 'whatsapp' OR kind = 'dm'),
  ADD FOREIGN KEY (tenant_id, wa_phone_number_id) REFERENCES whatsapp_accounts(tenant_id, phone_number_id) ON DELETE CASCADE;
CREATE INDEX outbound_jobs_wa_sent_idx ON outbound_jobs (tenant_id, wa_phone_number_id, kind, sent_at);

ALTER TABLE inbox_threads
  ADD COLUMN wa_phone_number_id text,
  DROP CONSTRAINT inbox_threads_one_account,
  ADD CONSTRAINT inbox_threads_one_account CHECK (
    (channel = 'instagram' AND ig_user_id IS NOT NULL AND fb_page_id IS NULL AND wa_phone_number_id IS NULL)
    OR (channel = 'facebook' AND fb_page_id IS NOT NULL AND ig_user_id IS NULL AND wa_phone_number_id IS NULL)
    OR (channel = 'whatsapp' AND wa_phone_number_id IS NOT NULL AND ig_user_id IS NULL AND fb_page_id IS NULL)
  ),
  ADD FOREIGN KEY (tenant_id, wa_phone_number_id) REFERENCES whatsapp_accounts(tenant_id, phone_number_id) ON DELETE CASCADE;
CREATE INDEX inbox_threads_wa_idx ON inbox_threads (tenant_id, wa_phone_number_id);

-- A keyword set and what it answers with: one of the business's reels, or a landing link. Matched with the same
-- matcher as comments (PRD 6.2), lowest position first.
CREATE TABLE whatsapp_keywords (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  keywords   text[] NOT NULL CHECK (cardinality(keywords) BETWEEN 1 AND 20),
  reel_id    integer,
  link_url   text NOT NULL DEFAULT '' CHECK (length(link_url) <= 2000),
  -- The reply. {link} is replaced by the direct link; with none, the link follows the text.
  message    text NOT NULL DEFAULT '' CHECK (length(message) <= 1000),
  position   integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT whatsapp_keywords_one_target CHECK ((reel_id IS NOT NULL) <> (link_url <> '')),
  FOREIGN KEY (tenant_id, reel_id) REFERENCES reels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_keywords_list_idx ON whatsapp_keywords (tenant_id, active, position, id);
CREATE INDEX whatsapp_keywords_reel_idx ON whatsapp_keywords (tenant_id, reel_id);
SELECT fence_tenant_table('whatsapp_keywords');

-- Who said yes to messages the business starts, per purpose (PRD 6.12). phone_hash is the compliance subject hash of
-- the number on the whatsapp channel (the same value as outbound_jobs.subject_hash), never the number. A withdrawal
-- keeps the row and sets withdrawn_at; saying yes again clears it.
CREATE TABLE whatsapp_optins (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_hash   text NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  purpose      text NOT NULL CHECK (purpose IN ('marketing', 'order_updates')),
  source       text NOT NULL CHECK (source IN ('keyword', 'checkout', 'account', 'form', 'seller', 'import')),
  opted_in_at  timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone_hash, purpose)
);
CREATE INDEX whatsapp_optins_list_idx ON whatsapp_optins (tenant_id, opted_in_at DESC, id DESC);
SELECT fence_tenant_table('whatsapp_optins');
