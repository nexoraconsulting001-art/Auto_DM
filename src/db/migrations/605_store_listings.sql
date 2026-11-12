-- Phase 6 (PRD 10.13): what each store shows. Owner: src/modules/store-listings.
-- The checks here are the loosest of both stores; each store's own limits (STORE_LIMITS in src/contracts/apps.js) are
-- tighter and are checked by the module before saving. No listing ever names the platform.
CREATE TABLE store_listings (
  id                 serial PRIMARY KEY,
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform           text NOT NULL CHECK (platform IN ('android', 'ios')),
  locale             text NOT NULL DEFAULT 'en-IN' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  title              text NOT NULL DEFAULT '' CHECK (length(title) <= 30),
  short_description  text NOT NULL DEFAULT '' CHECK (length(short_description) <= 80),   -- Play short description / App Store subtitle
  full_description   text NOT NULL DEFAULT '' CHECK (length(full_description) <= 4000),
  keywords           text NOT NULL DEFAULT '' CHECK (length(keywords) <= 100),
  category           text NOT NULL DEFAULT '' CHECK (length(category) <= 40),
  whats_new          text NOT NULL DEFAULT '' CHECK (length(whats_new) <= 4000),
  data_safety        jsonb NOT NULL DEFAULT '{}',     -- Play data safety answers, prefilled from DATA_COLLECTED
  privacy_labels     jsonb NOT NULL DEFAULT '{}',     -- App Store privacy labels, prefilled from DATA_COLLECTED
  validation         jsonb NOT NULL DEFAULT '{}',
  validated_at       timestamptz,
  updated_by         integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, platform, locale),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (updated_by),
  CHECK ((title || short_description || full_description || keywords || whats_new) !~* 'bhava')
);
SELECT fence_tenant_table('store_listings');

-- The images: icon, adaptive icon parts, notification icon, splash, feature graphic and screenshots by device size. Files are
-- in private storage (never /media); spec_ok and spec_problems are checkAsset()'s answer.
CREATE TABLE listing_assets (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform       text NOT NULL CHECK (platform IN ('android', 'ios')),
  kind           text NOT NULL CHECK (kind IN ('icon', 'adaptive_foreground', 'adaptive_background', 'notification_icon', 'splash', 'feature_graphic', 'screenshot')),
  device         text NOT NULL DEFAULT '' CHECK (device IN ('', 'phone', 'iphone_6_9', 'iphone_6_5')),   -- screenshots only
  position       integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 9),
  storage_key    text NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 300),
  width          integer NOT NULL CHECK (width > 0),
  height         integer NOT NULL CHECK (height > 0),
  mime           text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes          integer NOT NULL CHECK (bytes > 0),
  sha256         text NOT NULL CHECK (length(sha256) = 64),
  source         text NOT NULL CHECK (source IN ('generated', 'build_capture', 'upload')),
  build_id       bigint,
  spec_ok        boolean NOT NULL,
  spec_problems  jsonb NOT NULL DEFAULT '[]',         -- [{ code, message }]
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, platform, kind, device, position),
  FOREIGN KEY (tenant_id, build_id) REFERENCES app_builds(tenant_id, id) ON DELETE SET NULL (build_id),
  CHECK ((kind = 'screenshot') = (device <> '')),
  CHECK (kind <> 'screenshot' OR source = 'build_capture')     -- screenshots come from the real build, never a mock-up
);
SELECT fence_tenant_table('listing_assets');
