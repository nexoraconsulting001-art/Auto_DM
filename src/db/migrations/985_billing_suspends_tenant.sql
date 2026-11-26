-- R3-MONEY-1 (D1-PENDING-1, F-53): PRD 5.1 and 5.12 say a business whose grace ran out "is suspended", and tenants.status
-- has a 'suspended' value that the compliance gate, Instagram and Facebook connect, the import re-checks and the insights
-- poller already read. Billing only ever set subscriptions.status, so the business itself never showed as suspended.
-- Billing now moves tenants.status to 'suspended' when the subscription is suspended and back when it is paid or support
-- resumes it. This column keeps the status the business had before billing suspended it: it marks the suspension as
-- billing's (so a payment never lifts one made some other way) and says what to restore.
ALTER TABLE tenants ADD COLUMN billing_suspended_from text
  CHECK (billing_suspended_from IS NULL OR billing_suspended_from IN ('onboarding', 'active', 'paused'));
