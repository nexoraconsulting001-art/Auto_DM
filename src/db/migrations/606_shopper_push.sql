-- Phase 6 (PRD 10.11): push to shoppers, from the brand's own FCM project and APNs key. Owner: src/modules/shopper-push.
-- Registering a device never opts it in: each of the three toggles holds the time it was turned on, or NULL for off, and
-- every change is a row of shopper_push_consents. The weekly cap is counted in shopper_push_log.

CREATE TABLE shopper_push_devices (
  id                   bigserial PRIMARY KEY,
  tenant_id            integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id            text NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  shopper_id           integer,                                  -- NULL = a guest; erasing the shopper removes the row
  platform             text NOT NULL CHECK (platform IN ('android', 'ios')),
  token_enc            text CHECK (token_enc IS NULL OR token_enc LIKE 'v1.%'),   -- platform.secrets; NULL when there is none
  token_hash           text NOT NULL DEFAULT '',                 -- keyed hash, '' with no token
  app_version          text NOT NULL DEFAULT '' CHECK (length(app_version) <= 20),
  permission           text NOT NULL DEFAULT 'not_asked' CHECK (permission IN ('not_asked', 'granted', 'provisional', 'denied')),
  permission_at        timestamptz,
  order_updates_on_at  timestamptz,                              -- NULL = off; the value is when it was turned on
  offers_on_at         timestamptz,
  new_reels_on_at      timestamptz,
  last_ok_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  delete_reason        text NOT NULL DEFAULT '' CHECK (delete_reason IN ('', 'unregistered', 'invalid_token', 'removed')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE,
  CHECK ((token_enc IS NULL) = (token_hash = '')),
  CHECK (token_enc IS NULL OR permission IN ('granted', 'provisional')),     -- a token is held only while the system permission is
  CHECK (deleted_at IS NULL OR token_enc IS NULL),
  CHECK ((deleted_at IS NULL) = (delete_reason = ''))
);
CREATE UNIQUE INDEX shopper_push_devices_token ON shopper_push_devices (tenant_id, token_hash) WHERE token_hash <> '';
CREATE INDEX shopper_push_devices_shopper_idx ON shopper_push_devices (tenant_id, shopper_id) WHERE deleted_at IS NULL;
SELECT fence_tenant_table('shopper_push_devices');

-- Every toggle change, for the record. Insert-only.
CREATE TABLE shopper_push_consents (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_row_id   bigint NOT NULL,
  shopper_id      integer,
  toggle          text NOT NULL CHECK (toggle IN ('order_updates', 'offers', 'new_reels')),
  granted         boolean NOT NULL,
  source          text NOT NULL CHECK (source IN ('first_order_prompt', 'settings', 'system_permission', 'sign_out', 'token_rejected')),
  notice_version  integer,
  at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, device_row_id) REFERENCES shopper_push_devices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopper_push_consents_device_idx ON shopper_push_consents (tenant_id, device_row_id, id);
SELECT fence_tenant_table('shopper_push_consents', 'SELECT, INSERT');

-- A guest's device follows an order it placed; a signed-in shopper's devices follow by shopper_id.
CREATE TABLE shopper_push_orders (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_row_id  bigint NOT NULL,
  order_id       integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_row_id, order_id),
  FOREIGN KEY (tenant_id, device_row_id) REFERENCES shopper_push_devices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopper_push_orders_order_idx ON shopper_push_orders (tenant_id, order_id);
SELECT fence_tenant_table('shopper_push_orders');

-- Offers the seller writes. A campaign never names a device or a shopper: the audience is whoever opted in to offers.
CREATE TABLE push_campaigns (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 65),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 178),
  coupon_id       integer,
  link_path       text NOT NULL DEFAULT '/' CHECK (link_path ~ '^/[A-Za-z0-9/_.-]{0,199}$' AND link_path !~ '//'),
  created_by      integer,
  request_key     text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'blocked', 'failed')),
  block_reason    text NOT NULL DEFAULT '' CHECK (block_reason IN ('', 'weekly_cap', 'no_credentials', 'no_audience', 'wording')),
  audience_count  integer NOT NULL DEFAULT 0 CHECK (audience_count >= 0),
  sent_count      integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  capped_count    integer NOT NULL DEFAULT 0 CHECK (capped_count >= 0),
  failed_count    integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  send_after      timestamptz,                             -- set when it was written in quiet hours
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, request_key),
  FOREIGN KEY (tenant_id, coupon_id) REFERENCES coupons(tenant_id, id) ON DELETE SET NULL (coupon_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by),
  CHECK ((status = 'blocked') = (block_reason <> ''))
);
CREATE INDEX push_campaigns_recent_idx ON push_campaigns (tenant_id, created_at DESC);
SELECT fence_tenant_table('push_campaigns');

-- One row per push per device: claimed before sending, so one event is one push however often it is delivered.
-- shopper_id has no key on purpose: the row outlives a sign-out, and goes with the device.
CREATE TABLE shopper_push_log (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_row_id  bigint NOT NULL,
  shopper_id     integer,
  cap_subject    text NOT NULL CHECK (cap_subject ~ '^(s|d):[0-9]+$'),    -- 's:<shopper id>' when signed in, else 'd:<device row id>'
  kind           text NOT NULL CHECK (kind IN ('order_update', 'offer', 'new_reel')),
  source_kind    text NOT NULL CHECK (source_kind IN ('order_event', 'campaign', 'category_reel')),
  source_id      text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 80),
  week_start     date NOT NULL,                                            -- the Monday of that week, Asia/Kolkata
  status         text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'skipped')),
  reason         text NOT NULL DEFAULT '' CHECK (length(reason) <= 40),
  provider_id    text NOT NULL DEFAULT '' CHECK (length(provider_id) <= 200),
  attempts       smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_row_id, source_kind, source_id),
  FOREIGN KEY (tenant_id, device_row_id) REFERENCES shopper_push_devices(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopper_push_log_cap_idx ON shopper_push_log (tenant_id, cap_subject, week_start) WHERE kind IN ('offer', 'new_reel');
SELECT fence_tenant_table('shopper_push_log', 'SELECT, INSERT, UPDATE');

-- The outbox for "a reel joined a category". Keyed to the category and the reel, not to category_reels, so the row outlives
-- a removal: removed and added again is still one push.
CREATE TABLE shopper_push_events (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id   integer NOT NULL,
  page_id       integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  outcome       text NOT NULL DEFAULT '' CHECK (outcome IN ('', 'sent', 'merged', 'not_visible', 'no_app', 'no_audience')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, category_id, page_id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopper_push_events_due_idx ON shopper_push_events (tenant_id, created_at) WHERE processed_at IS NULL;
SELECT fence_tenant_table('shopper_push_events', 'SELECT, INSERT, UPDATE');

-- The brand's own FCM project and APNs key. Encrypted, shown masked, never returned.
CREATE TABLE app_push_credentials (
  tenant_id                integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  fcm_project_id           text NOT NULL DEFAULT '' CHECK (length(fcm_project_id) <= 80),
  fcm_client_email         text NOT NULL DEFAULT '' CHECK (length(fcm_client_email) <= 254),   -- shown masked
  fcm_service_account_enc  text CHECK (fcm_service_account_enc IS NULL OR fcm_service_account_enc LIKE 'v1.%'),
  fcm_status               text NOT NULL DEFAULT 'not_set' CHECK (fcm_status IN ('not_set', 'ok', 'invalid')),
  apns_key_id              text NOT NULL DEFAULT '' CHECK (apns_key_id = '' OR apns_key_id ~ '^[A-Z0-9]{10}$'),
  apns_team_id             text NOT NULL DEFAULT '' CHECK (apns_team_id = '' OR apns_team_id ~ '^[A-Z0-9]{10}$'),
  apns_topic               text NOT NULL DEFAULT '' CHECK (length(apns_topic) <= 155),         -- the bundle id
  apns_env                 text NOT NULL DEFAULT 'production' CHECK (apns_env IN ('production', 'sandbox')),
  apns_key_enc             text CHECK (apns_key_enc IS NULL OR apns_key_enc LIKE 'v1.%'),
  apns_status              text NOT NULL DEFAULT 'not_set' CHECK (apns_status IN ('not_set', 'ok', 'invalid')),
  updated_by               integer,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (updated_by)
);
SELECT fence_tenant_table('app_push_credentials');

-- The one seam into the categories module: a reel joining a category of a business with an app writes the outbox row.
CREATE FUNCTION category_reels_push_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_configs WHERE tenant_id = NEW.tenant_id) THEN
    INSERT INTO shopper_push_events (tenant_id, category_id, page_id) VALUES (NEW.tenant_id, NEW.category_id, NEW.page_id)
    ON CONFLICT (tenant_id, category_id, page_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER category_reels_push_event AFTER INSERT ON category_reels FOR EACH ROW EXECUTE FUNCTION category_reels_push_event();
