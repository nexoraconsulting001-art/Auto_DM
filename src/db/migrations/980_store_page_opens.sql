-- Which landing page (reel link) a browser opened last (PRD 9.5, S-17). The server writes this when a visitor opens /r/<slug>, and
-- checkout reads it to name the order's source reel, so what the page or the request body claims never decides it. The session id
-- is a random value in the store's own cookie: no name, number or address, and it belongs to one business only.
CREATE TABLE store_page_opens (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  page_id    integer NOT NULL,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX store_page_opens_age_idx ON store_page_opens (opened_at);
SELECT fence_tenant_table('store_page_opens');
