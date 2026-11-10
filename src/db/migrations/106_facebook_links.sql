-- Phase 1: a Facebook post linked to its Instagram twin (PRD 6.10). Bhava suggests, the owner confirms, and fixing a
-- link changes only what happens to new comments.
CREATE TABLE fb_post_links (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fb_page_id   text NOT NULL,
  fb_post_id   text NOT NULL,
  ig_media_id  text NOT NULL,
  status       text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  score        real NOT NULL DEFAULT 0,
  confirmed_by integer,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, fb_post_id, ig_media_id),
  FOREIGN KEY (tenant_id, fb_page_id) REFERENCES fb_pages(tenant_id, page_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, confirmed_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (confirmed_by)
);
CREATE UNIQUE INDEX fb_post_links_confirmed_post_idx ON fb_post_links (tenant_id, fb_post_id) WHERE status = 'confirmed';
CREATE UNIQUE INDEX fb_post_links_confirmed_media_idx ON fb_post_links (tenant_id, ig_media_id) WHERE status = 'confirmed';
CREATE INDEX fb_post_links_page_idx ON fb_post_links (tenant_id, fb_page_id, status);
CREATE INDEX fb_post_links_confirmed_by_idx ON fb_post_links (tenant_id, confirmed_by);
SELECT fence_tenant_table('fb_post_links');
