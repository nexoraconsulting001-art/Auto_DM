-- Phase 0: addresses Bhava keeps for itself. NOT VALID: applies to new and changed rows only.
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_not_reserved
  CHECK (slug NOT IN ('bhava', 'www', 'app', 'api', 'admin')) NOT VALID;
