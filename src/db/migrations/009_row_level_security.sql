-- Phase 0: row-level security (PRD 5.1). Business transactions run as the non-owner role bhava_app with
-- app.tenant_id set for that transaction only (src/db/index.js), and these policies then show them that
-- business's rows and nothing else, even if a query forgets its WHERE. The role is created by runMigrations,
-- because a role belongs to the whole server and a restore has to be able to make it too.

-- The business of this transaction. NULL when none is set, and then no policy matches any row.
CREATE FUNCTION current_tenant_id() RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::integer
$$;

-- Every table with a tenant_id goes through this, once, right after it is created:
--   SELECT fence_tenant_table('widgets');                          -- read and write
--   SELECT fence_tenant_table('widget_log', 'SELECT, INSERT');     -- insert-only
-- The recipe for a new table is in HANDOFF.md.
CREATE FUNCTION fence_tenant_table(tbl regclass, privileges text DEFAULT 'SELECT, INSERT, UPDATE, DELETE') RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  seq regclass;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY tenant_fence ON %s USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', tbl);
  EXECUTE format('GRANT %s ON %s TO bhava_app', privileges, tbl);
  FOR seq IN
    SELECT c.oid FROM pg_class c JOIN pg_depend d ON d.objid = c.oid
    WHERE c.relkind = 'S' AND d.refobjid = tbl AND d.deptype IN ('a', 'i')
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO bhava_app', seq);
  END LOOP;
END $$;

SELECT fence_tenant_table(t) FROM unnest(ARRAY[
  'tenant_domains', 'ig_accounts', 'tenant_features', 'settings', 'media', 'products', 'reels', 'reel_products',
  'categories', 'product_categories', 'users', 'sessions', 'orders', 'order_items', 'activity', 'visits',
  'events', 'brand_kits'
]::regclass[]) AS list(t);

-- The logs and the queue. Business code may add to them and read its own rows, and nothing else: only the
-- retention job, which runs outside any business, can delete. Rows with no tenant_id are never visible here.
SELECT fence_tenant_table(t, 'SELECT, INSERT') FROM unnest(ARRAY['audit_log', 'compliance_events', 'jobs']::regclass[]) AS list(t);

-- A business sees its own row of tenants, and the one thing it changes itself is its order counter.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON tenants USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());
GRANT SELECT ON tenants TO bhava_app;
GRANT UPDATE (next_order_number) ON tenants TO bhava_app;

-- Shared reference data, the same for every business.
GRANT SELECT ON plans, plan_features, theme_presets TO bhava_app;
