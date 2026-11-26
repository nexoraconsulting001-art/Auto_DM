
## R2-CORE-1 (2026-11-26) HIGH (business separation): provider_webhook_events and shared_profile_links had a tenant_id but no row-level security (p0 foundation-gaps/rls F-04, p0 spec-p0/tenancy F-04)
- Root cause: the Phase 4 contract (5ad3cfc) created both tables (404_payments, 415_shared_shoppers) as platform-only (db.platform, no grant to bhava_app) and so skipped fence_tenant_table; the platform-only pattern (741 instagram_tenants, seller_payment_marks) still enables RLS and the tenant policy so a later grant cannot open other businesses' rows. No leak today (no grant), but the fence was missing.
- Fix: migration 960_platform_rows_fenced.sql enables RLS and the tenant_fence policy on both, no grants. db.platform (owner, no FORCE) is unchanged. Grepped: no other tenant_id table lacks a policy (the rls test lists every one).
- Proof (PGlite): rls.test 11/11, spec-p0 tenancy 12/12, p4/shoppers/shared 8/8.
