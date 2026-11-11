-- Phase 5 (PRD 5.13, 10.5): notifications to sellers. One service (ctx.notify, src/modules/notifications) turns each
-- event into deliveries on push, email, WhatsApp and in-app. The numbers and the wording are in
-- src/contracts/notifications.js. All four are tenant tables, following the tenant pattern; a recipient is the account
-- a person has in that business (users), so the database refuses a delivery to an account of another business, and
-- removing someone from a team (users.removed_at) is all it takes for them to get nothing more.

-- The outbox. emit() writes a row in the transaction of its caller, so no change commits without its notification and
-- none is sent for a change that rolled back. data is ids and numbers only: never a name, a number or a word of text.
-- One live row per (business, kind, key): a repeat inside ten minutes finds it and is dropped; after ten minutes emit()
-- clears `live` on the old row first, so the key can be used for something that happened again.
CREATE TABLE notification_events (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(kind) <= 60),
  event_key     text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 120),
  -- Who it is for: "owner", "managers", a permission, or {"userId": 12}. Recipients are worked out when it is handed out.
  audience      jsonb NOT NULL CHECK (jsonb_typeof(audience) IN ('string', 'object')),
  -- Only these channels, when set (a report delivery is for one channel). Empty means the channels of the kind.
  channels      text[] CHECK (channels <@ ARRAY['push', 'email', 'whatsapp', 'inapp']),
  data          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object' AND length(data::text) <= 2000),
  -- The record a tap opens, as a path: the owner app and the console each open their own form of it.
  link          text NOT NULL DEFAULT '/' CHECK (link ~ '^/[a-z0-9/_-]*$' AND length(link) <= 200),
  live          boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  fanned_out_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX notification_events_key_idx ON notification_events (tenant_id, kind, event_key) WHERE live;
CREATE INDEX notification_events_new_idx ON notification_events (id) WHERE fanned_out_at IS NULL;
CREATE INDEX notification_events_kind_idx ON notification_events (tenant_id, kind, created_at DESC);
SELECT fence_tenant_table('notification_events', 'SELECT, INSERT, UPDATE');

-- The delivery log: one row per event, recipient and channel, so nothing is sent twice however often a job repeats.
--   queued     waiting for next_attempt_at (quiet hours, the collapse hold, or backoff after a failed try)
--   sent       provider_ref is the id the provider gave it
--   failed     three tries, or a refusal that another try cannot change; reason is the kind of provider error
--   dropped    never tried: switched off, no address, removed from the business, channel not configured
--   collapsed  a push that went out as part of another: collapsed_into is the delivery that carried it
-- attempt cannot pass 3 in the database, so a fourth try cannot be recorded and cannot be made.
CREATE TABLE notification_deliveries (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id        bigint NOT NULL,
  user_id         integer NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('push', 'email', 'whatsapp', 'inapp')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'dropped', 'collapsed')),
  attempt         smallint NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  provider_ref    text NOT NULL DEFAULT '' CHECK (length(provider_ref) <= 200),
  reason          text NOT NULL DEFAULT '' CHECK (length(reason) <= 80),
  collapsed_into  bigint,
  -- How many events this push stands for: 1, or more for the delivery that carries a group.
  group_count     integer NOT NULL DEFAULT 1 CHECK (group_count >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (event_id, user_id, channel),
  FOREIGN KEY (tenant_id, event_id) REFERENCES notification_events(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, collapsed_into) REFERENCES notification_deliveries(tenant_id, id) ON DELETE CASCADE,
  CHECK (status NOT IN ('failed', 'dropped') OR reason <> ''),
  CHECK ((status = 'collapsed') = (collapsed_into IS NOT NULL)),
  CHECK (status <> 'collapsed' OR channel = 'push'),
  CHECK (collapsed_into IS NULL OR collapsed_into <> id),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at) WHERE status = 'queued';
CREATE INDEX notification_deliveries_user_idx ON notification_deliveries (tenant_id, user_id, id DESC);
CREATE INDEX notification_deliveries_group_idx ON notification_deliveries (tenant_id, collapsed_into) WHERE collapsed_into IS NOT NULL;
SELECT fence_tenant_table('notification_deliveries', 'SELECT, INSERT, UPDATE');

-- The in-app list: what one person sees in one business. The words are those Bhava says to the seller, made from the
-- wording of the kind, so they hold nothing about a shopper.
CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    integer NOT NULL,
  event_id   bigint NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body       text NOT NULL DEFAULT '' CHECK (length(body) <= 240),
  link       text NOT NULL DEFAULT '/' CHECK (link ~ '^/[a-z0-9/_-]*$' AND length(link) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (event_id, user_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES notification_events(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_list_idx ON notifications (tenant_id, user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (tenant_id, user_id) WHERE read_at IS NULL;
SELECT fence_tenant_table('notifications', 'SELECT, INSERT, UPDATE');

-- What one person chose in one business: quiet hours, and per kind and channel only what differs from the defaults of
-- the kind, as {"order.new": {"email": false}}. No row means every default.
CREATE TABLE notification_prefs (
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       integer NOT NULL,
  quiet_enabled boolean NOT NULL DEFAULT false,
  quiet_from    text NOT NULL DEFAULT '22:00' CHECK (quiet_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_to      text NOT NULL DEFAULT '07:00' CHECK (quiet_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata' CHECK (length(timezone) BETWEEN 1 AND 64),
  events        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(events) = 'object' AND length(events::text) <= 8000),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('notification_prefs');

-- The two outboxes that were waiting for this (migrations 108 and 205) become sources: the notifications module takes
-- rows whose notified_at is empty and stamps them. What was already there when this ran is not sent late.
ALTER TABLE alerts ADD COLUMN notified_at timestamptz;
UPDATE alerts SET notified_at = created_at;
CREATE INDEX alerts_to_notify_idx ON alerts (id) WHERE notified_at IS NULL AND audience = 'owner';

ALTER TABLE report_deliveries ADD COLUMN notified_at timestamptz;
UPDATE report_deliveries SET notified_at = created_at;
CREATE INDEX report_deliveries_to_notify_idx ON report_deliveries (id) WHERE notified_at IS NULL AND status = 'queued';
