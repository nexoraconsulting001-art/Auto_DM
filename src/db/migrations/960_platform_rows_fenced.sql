-- Two platform-only tables from the Phase 4 contract (5ad3cfc) hold a tenant_id but were never put behind the fence:
-- provider_webhook_events (404) and shared_profile_links (415). Both are read and written through db.platform only, so
-- the app role gets no grant here; row-level security and the tenant policy make sure that, if one is ever given, a
-- business still sees only its own rows (F-04). Same pattern as instagram_tenants and seller_payment_marks (741).
ALTER TABLE provider_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON provider_webhook_events USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE shared_profile_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON shared_profile_links USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
