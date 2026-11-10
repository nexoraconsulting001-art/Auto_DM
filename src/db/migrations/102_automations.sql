-- Phase 1: automations, what triggers them, and what they say (PRD 6.1 to 6.9).

CREATE TABLE automations (
  id                     serial PRIMARY KEY,
  tenant_id              integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  slug                   text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$'),   -- utm_campaign
  state                  text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'test', 'live', 'paused', 'archived')),
  paused_reason          text NOT NULL DEFAULT '',
  trigger_type           text NOT NULL CHECK (trigger_type IN ('comment', 'story_reply', 'story_mention', 'dm_keyword', 'dm_welcome')),
  match_mode             text NOT NULL DEFAULT 'keywords' CHECK (match_mode IN ('keywords', 'any')),
  any_mode_acknowledged  timestamptz,                                  -- when the owner saw the Reach Guard warning
  keywords               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 20),
  include_reactions      boolean NOT NULL DEFAULT false,
  priority               integer NOT NULL DEFAULT 0,
  link_mode              text NOT NULL DEFAULT 'two_tap' CHECK (link_mode IN ('one_tap', 'two_tap')),
  link_type              text NOT NULL DEFAULT 'seller_site' CHECK (link_type IN ('seller_site', 'bhava_page', 'amazon', 'affiliate', 'whatsapp')),
  link_url               text NOT NULL DEFAULT '',
  tap_button_title       text NOT NULL DEFAULT 'Send me the link',
  link_button_title      text NOT NULL DEFAULT 'Open the link',
  link_status            text NOT NULL DEFAULT 'unchecked' CHECK (link_status IN ('unchecked', 'ok', 'failed')),
  link_checked_at        timestamptz,
  public_reply_enabled   boolean NOT NULL DEFAULT false,
  followup_enabled       boolean NOT NULL DEFAULT false,
  followup_delay_minutes integer NOT NULL DEFAULT 30 CHECK (followup_delay_minutes >= 30),
  starts_at              timestamptz,
  ends_at                timestamptz,
  daily_start            time,
  daily_end              time,
  outside_hours          text NOT NULL DEFAULT 'hold' CHECK (outside_hours IN ('hold', 'skip')),
  dry_run                boolean NOT NULL DEFAULT false,
  winner_variant_id      integer,
  created_by             integer,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX automations_state_idx ON automations (tenant_id, state, priority DESC);
CREATE INDEX automations_created_by_idx ON automations (tenant_id, created_by);
CREATE INDEX automations_ends_idx ON automations (ends_at) WHERE ends_at IS NOT NULL AND state IN ('live', 'test');
CREATE INDEX automations_link_check_idx ON automations (link_checked_at) WHERE state = 'live';
SELECT fence_tenant_table('automations');

-- A media id is unique per business and channel, never across Bhava, so one business can't lock another out of a post.
-- An archived automation's triggers are inactive and free the media for a new one.
CREATE TABLE automation_triggers (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id integer NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  target_type   text NOT NULL CHECK (target_type IN ('reel', 'post', 'story', 'any_story', 'dm')),
  media_id      text NOT NULL DEFAULT '',
  permalink     text NOT NULL DEFAULT '',
  thumbnail_url text NOT NULL DEFAULT '',
  caption       text NOT NULL DEFAULT '',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((target_type IN ('reel', 'post', 'story')) = (media_id <> '')),
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX automation_triggers_automation_idx ON automation_triggers (tenant_id, automation_id);
CREATE UNIQUE INDEX automation_triggers_media_idx ON automation_triggers (tenant_id, channel, media_id) WHERE media_id <> '' AND active;
CREATE UNIQUE INDEX automation_triggers_any_story_idx ON automation_triggers (tenant_id, channel) WHERE target_type = 'any_story' AND active;
SELECT fence_tenant_table('automation_triggers');

-- What a message says. automation_id is null for what belongs to the whole business (the opt-out confirmation).
CREATE TABLE message_templates (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  automation_id integer,
  role          text NOT NULL CHECK (role IN ('first_dm', 'link_dm', 'followup', 'welcome', 'faq_answer', 'optout_confirm')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, automation_id) REFERENCES automations(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX message_templates_automation_idx ON message_templates (tenant_id, automation_id, role) WHERE automation_id IS NOT NULL;
CREATE INDEX message_templates_automation_fk_idx ON message_templates (tenant_id, automation_id);
CREATE UNIQUE INDEX message_templates_business_idx ON message_templates (tenant_id, role) WHERE automation_id IS NULL AND role <> 'faq_answer';
SELECT fence_tenant_table('message_templates');

-- Up to 3 versions of a message (PRD 6.5). A template with one version just has label A.
CREATE TABLE template_variants (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id   integer NOT NULL,
  label         text NOT NULL CHECK (label IN ('A', 'B', 'C')),
  body          text NOT NULL,
  button_title  text NOT NULL DEFAULT '',
  fallback_text text NOT NULL DEFAULT '',
  quick_replies jsonb NOT NULL DEFAULT '[]',
  weight        integer NOT NULL DEFAULT 1 CHECK (weight >= 0),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, template_id, label),
  FOREIGN KEY (tenant_id, template_id) REFERENCES message_templates(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('template_variants');

ALTER TABLE automations ADD CONSTRAINT automations_winner_fk
  FOREIGN KEY (tenant_id, winner_variant_id) REFERENCES template_variants(tenant_id, id) ON DELETE SET NULL (winner_variant_id);
CREATE INDEX automations_winner_idx ON automations (tenant_id, winner_variant_id);

CREATE TABLE ice_breakers (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  position    integer NOT NULL CHECK (position BETWEEN 1 AND 4),
  question    text NOT NULL,
  template_id integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, position),
  FOREIGN KEY (tenant_id, template_id) REFERENCES message_templates(tenant_id, id) ON DELETE SET NULL (template_id)
);
CREATE INDEX ice_breakers_template_idx ON ice_breakers (tenant_id, template_id);
SELECT fence_tenant_table('ice_breakers');

-- Testers are known only by the id the webhook captured (PRD 6.9). There is no username lookup.
CREATE TABLE testers (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('instagram', 'facebook')),
  subject_hash text NOT NULL,
  recipient_id text NOT NULL,
  label        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, subject_hash)
);
SELECT fence_tenant_table('testers');

-- A one-time code the tester DMs to the business. Only a hash is stored; it works for 15 minutes.
CREATE TABLE tester_codes (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  created_by integer,
  tester_id  integer,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code_hash),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by),
  FOREIGN KEY (tenant_id, tester_id) REFERENCES testers(tenant_id, id) ON DELETE SET NULL (tester_id)
);
CREATE INDEX tester_codes_created_by_idx ON tester_codes (tenant_id, created_by);
CREATE INDEX tester_codes_tester_idx ON tester_codes (tenant_id, tester_id);
CREATE INDEX tester_codes_expiry_idx ON tester_codes (expires_at);
SELECT fence_tenant_table('tester_codes');
