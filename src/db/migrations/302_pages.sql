-- Phase 3: a landing page per automated reel, post or story (PRD 8.10), the WhatsApp order button (8.11), share previews
-- (8.12) and the business's block layout (5.18). The Phase 0 reels table already holds one page per media with its slug and
-- its ordered products, and orders and the DM link point at it, so it becomes the landing page table for every kind.

ALTER TABLE reels
  ADD COLUMN id             serial,
  ADD COLUMN kind           text NOT NULL DEFAULT 'reel' CHECK (kind IN ('reel', 'post', 'story')),
  ADD COLUMN channel        text NOT NULL DEFAULT 'instagram' CHECK (channel IN ('instagram', 'facebook')),
  ADD COLUMN media_type     text NOT NULL DEFAULT '' CHECK (media_type IN ('', 'VIDEO', 'IMAGE', 'CAROUSEL_ALBUM')),
  -- Media shows media_url, else thumbnail_url (VIDEO only), else the permalink; refreshed at most every 6 hours (8.10).
  ADD COLUMN media_url      text NOT NULL DEFAULT '' CHECK (length(media_url) <= 2000),
  ADD COLUMN posted_at      timestamptz,
  -- A story's media is never copied (4.14): after expires_at the page shows cover_media_id, or the first product's image.
  ADD COLUMN expires_at     timestamptz,
  ADD COLUMN cover_media_id uuid,
  ADD COLUMN description    text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  -- NULL follows the business's lead form setting for landing pages (8.15); true or false overrides it for this page.
  ADD COLUMN lead_form      boolean,
  ADD CONSTRAINT reels_tenant_id_id_key UNIQUE (tenant_id, id),
  ADD CONSTRAINT reels_story_expiry CHECK (kind <> 'story' OR expires_at IS NOT NULL OR posted_at IS NULL),
  ADD CONSTRAINT reels_cover_fk FOREIGN KEY (tenant_id, cover_media_id) REFERENCES media(tenant_id, id) ON DELETE SET NULL (cover_media_id);
CREATE INDEX reels_cover_idx ON reels (tenant_id, cover_media_id);
CREATE INDEX reels_live_idx ON reels (tenant_id, active, created_at DESC);
GRANT USAGE, SELECT ON SEQUENCE reels_id_seq TO bhava_app;

-- The business's page choices. No row means the defaults.
CREATE TABLE page_settings (
  tenant_id         integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- The Order on WhatsApp button (8.11) uses the saved support_whatsapp number; with none saved it never shows.
  whatsapp_order    boolean NOT NULL DEFAULT false,
  whatsapp_template text NOT NULL DEFAULT 'Hi, I would like to order {product} ({price}). {url}' CHECK (length(whatsapp_template) BETWEEN 1 AND 500),
  -- Landing pages are noindex by default (8.12); the creator page is indexable (8.14).
  landing_noindex   boolean NOT NULL DEFAULT true,
  more_reels        boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('page_settings');

-- One share preview per thing that can be shared: a landing page, the creator page, a shelf or category. The image is a new
-- media file whenever what it shows changes, so its address changes too and Meta's cache by address can't show the old one (K-39).
CREATE TABLE share_previews (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target       text NOT NULL CHECK (target ~ '^(page:[1-9][0-9]{0,9}|creator|shelf:[1-9][0-9]{0,9}|category:[1-9][0-9]{0,9}|product:[1-9][0-9]{0,9})$'),
  version      text NOT NULL CHECK (version ~ '^[0-9a-f]{8,64}$'),          -- a hash of what the image was drawn from
  media_id     uuid,
  width        integer CHECK (width IS NULL OR width >= 200),
  height       integer CHECK (height IS NULL OR height >= 200),
  title        text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, target),
  FOREIGN KEY (tenant_id, media_id) REFERENCES media(tenant_id, id) ON DELETE SET NULL (media_id)
);
CREATE INDEX share_previews_media_idx ON share_previews (tenant_id, media_id);
SELECT fence_tenant_table('share_previews');

-- The block library (5.18 level 3): ready-made blocks every business shares as code, placed and ordered per business as data.
-- `block` is a name from BUYER_BLOCKS in src/contracts/buyer-pages.js; `settings` is that block's validated settings.
CREATE TABLE page_blocks (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  surface    text NOT NULL CHECK (surface IN ('landing', 'creator', 'store_home')),
  block      text NOT NULL CHECK (block ~ '^[a-z][a-z0-9_]{1,39}$'),
  position   integer NOT NULL CHECK (position >= 0),
  visible    boolean NOT NULL DEFAULT true,
  settings   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, surface, position) DEFERRABLE INITIALLY DEFERRED
);
SELECT fence_tenant_table('page_blocks');
