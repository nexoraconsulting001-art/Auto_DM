-- Phase 3: the creator page (PRD 8.14): one searchable page of a business's reels and products, on its own host at /<slug>,
-- with a shelf per category at /<slug>/<category slug>. Shelves follow the category order and each category's reel sequence
-- (8.13), so nothing about order is stored here.

CREATE TABLE creator_pages (
  id              serial PRIMARY KEY,
  tenant_id       integer NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  -- The first path segment on the business's host. Names the app already uses are refused in code (RESERVED_PATHS).
  slug            text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  enabled         boolean NOT NULL DEFAULT false,
  display_name    text NOT NULL DEFAULT '' CHECK (length(display_name) <= 80),
  bio             text NOT NULL DEFAULT '' CHECK (length(bio) <= 300),
  photo_media_id  uuid,
  website_url     text NOT NULL DEFAULT '' CHECK (website_url = '' OR website_url ~ '^https://' AND length(website_url) <= 1000),
  show_whatsapp   boolean NOT NULL DEFAULT true,
  more_shelf_title text NOT NULL DEFAULT 'More reels' CHECK (length(more_shelf_title) BETWEEN 1 AND 40),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, photo_media_id) REFERENCES media(tenant_id, id) ON DELETE SET NULL (photo_media_id)
);
CREATE INDEX creator_pages_photo_idx ON creator_pages (tenant_id, photo_media_id);
SELECT fence_tenant_table('creator_pages');
