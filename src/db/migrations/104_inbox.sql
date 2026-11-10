-- Phase 1: the owner inbox (PRD 6.7). The only place a display username is stored, with the message text, for 30 days.

CREATE TABLE inbox_threads (
  id                      serial PRIMARY KEY,
  tenant_id               integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel                 text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  ig_user_id              text,
  fb_page_id              text,
  subject_hash            text NOT NULL,
  recipient_id            text NOT NULL,                                -- the IGSID or PSID a reply is addressed to
  username                text NOT NULL DEFAULT '',
  last_message            text NOT NULL DEFAULT '',
  last_message_at         timestamptz,
  last_user_message_at    timestamptz,
  last_bot_message_at     timestamptz,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'needs_human', 'closed')),
  automation_paused_until timestamptz,
  pause_reason            text NOT NULL DEFAULT '' CHECK (pause_reason IN ('', 'thread.handoff', 'thread.owner_replied')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, subject_hash),
  CONSTRAINT inbox_threads_one_account CHECK (
    (channel = 'instagram' AND ig_user_id IS NOT NULL AND fb_page_id IS NULL)
    OR (channel = 'facebook' AND fb_page_id IS NOT NULL AND ig_user_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, ig_user_id) REFERENCES ig_accounts(tenant_id, ig_user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, fb_page_id) REFERENCES fb_pages(tenant_id, page_id) ON DELETE CASCADE
);
CREATE INDEX inbox_threads_list_idx ON inbox_threads (tenant_id, last_message_at DESC, id DESC);
CREATE INDEX inbox_threads_status_idx ON inbox_threads (tenant_id, status, last_message_at DESC);
CREATE INDEX inbox_threads_ig_idx ON inbox_threads (tenant_id, ig_user_id);
CREATE INDEX inbox_threads_fb_idx ON inbox_threads (tenant_id, fb_page_id);
CREATE INDEX inbox_threads_retention_idx ON inbox_threads (last_message_at);
SELECT fence_tenant_table('inbox_threads');

-- Story media is a reference only (media_ref): never downloaded or re-hosted (PRD 4.14).
CREATE TABLE inbox_messages (
  id         bigserial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id  integer NOT NULL,
  direction  text NOT NULL CHECK (direction IN ('in', 'out')),
  author     text NOT NULL CHECK (author IN ('person', 'automation', 'owner')),
  kind       text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'story_reply', 'story_mention', 'postback', 'attachment')),
  text       text NOT NULL DEFAULT '',
  media_ref  text NOT NULL DEFAULT '',
  mid        text,
  job_id     bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES inbox_threads(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES outbound_jobs(tenant_id, id) ON DELETE SET NULL (job_id)
);
CREATE INDEX inbox_messages_thread_idx ON inbox_messages (tenant_id, thread_id, created_at, id);
CREATE INDEX inbox_messages_job_idx ON inbox_messages (tenant_id, job_id);
CREATE INDEX inbox_messages_retention_idx ON inbox_messages (created_at);
CREATE UNIQUE INDEX inbox_messages_mid_idx ON inbox_messages (tenant_id, mid) WHERE mid IS NOT NULL;
SELECT fence_tenant_table('inbox_messages');

CREATE TABLE needs_human_items (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  thread_id    integer,
  job_id       bigint,
  kind         text NOT NULL CHECK (kind IN ('negative_comment', 'handoff', 'send_failed', 'unknown_outcome', 'why_no_dm')),
  reason       text NOT NULL DEFAULT '',
  subject_hash text NOT NULL DEFAULT '',
  comment_id   text NOT NULL DEFAULT '',
  media_id     text NOT NULL DEFAULT '',
  username     text NOT NULL DEFAULT '',
  text         text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by  integer,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES inbox_threads(tenant_id, id) ON DELETE SET NULL (thread_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES outbound_jobs(tenant_id, id) ON DELETE SET NULL (job_id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (resolved_by)
);
CREATE INDEX needs_human_list_idx ON needs_human_items (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX needs_human_thread_idx ON needs_human_items (tenant_id, thread_id);
CREATE INDEX needs_human_job_idx ON needs_human_items (tenant_id, job_id);
CREATE INDEX needs_human_resolved_by_idx ON needs_human_items (tenant_id, resolved_by);
CREATE INDEX needs_human_retention_idx ON needs_human_items (created_at);
SELECT fence_tenant_table('needs_human_items');
