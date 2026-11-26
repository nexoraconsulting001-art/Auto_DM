-- D1 (user decision 2026-11-26, B-MONEY-7 F-53): a failed Bhava payment gets 2 days of grace in production (the user's
-- range is 1 to 2 days), not 7. grace_days stays a setting in the Platform Console (billing_settings); only its default
-- moves. A row still at the old default of 7 moves with it; one Bhava's team set to anything else is kept.
ALTER TABLE billing_settings ALTER COLUMN grace_days SET DEFAULT 2;
UPDATE billing_settings SET grace_days = 2, updated_at = now() WHERE grace_days = 7;
