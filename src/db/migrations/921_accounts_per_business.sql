-- An Instagram account or Facebook Page sends for one business at a time, because webhooks route by its id alone. But when a
-- business disconnects it and another business connects it, the first business's inbox, send history and insights must stay
-- (tenancy-1): they reference (tenant_id, ig_user_id) and (tenant_id, page_id) and went with a deleted row. So each business
-- keeps its own row, and the database allows at most one live row per account. A row is released when its owner
-- disconnected it (no token, status_reason 'owner.disconnected', src/modules/ig-accounts/index.js); a released row is never
-- routed to while a live one exists (src/modules/ig-accounts/claim.js, src/repos/tenants.js).
ALTER TABLE ig_accounts DROP CONSTRAINT ig_accounts_pkey;
ALTER TABLE ig_accounts ADD PRIMARY KEY (tenant_id, ig_user_id);
CREATE UNIQUE INDEX ig_accounts_live_idx ON ig_accounts (ig_user_id) WHERE NOT (access_token_enc = '' AND status_reason = 'owner.disconnected');
CREATE INDEX ig_accounts_user_idx ON ig_accounts (ig_user_id);

ALTER TABLE fb_pages DROP CONSTRAINT fb_pages_pkey;
ALTER TABLE fb_pages ADD PRIMARY KEY (tenant_id, page_id);
CREATE UNIQUE INDEX fb_pages_live_idx ON fb_pages (page_id) WHERE NOT (access_token_enc = '' AND status_reason = 'owner.disconnected');
CREATE INDEX fb_pages_page_idx ON fb_pages (page_id);
