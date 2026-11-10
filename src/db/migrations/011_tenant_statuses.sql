-- Phase 0: the business statuses of PRD 5.1. 'killed' stays for anything already using it.
ALTER TABLE tenants DROP CONSTRAINT tenants_status_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('onboarding', 'active', 'paused', 'suspended', 'closed', 'killed'));
