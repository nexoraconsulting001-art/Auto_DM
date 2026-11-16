-- Final review (atk-auth-1, PRD 5.20, auth-2): the day's cap on new businesses counts every working business self-serve made
-- today, whichever way it was made. Before this, the count was "businesses with a sign-up run", so a first sign-in (F-109),
-- which makes a working Free business with no run, was never counted and first sign-ins could pass the cap without limit.
--
-- `signup_opened_at` is when self-serve gave the business its working place: set when a first sign-in makes a working
-- business, when signup.start makes one, and when signup.start adopts a held place. A held place has none (it is not a
-- business yet), and nor do businesses we onboard from the console, the demo business or seeds: the cap is a launch
-- ceiling on self-serve only. The count is signup_made_today(), the one definition the sign-up module, the first sign-in and
-- the triggers below all use.
ALTER TABLE tenants ADD COLUMN signup_opened_at timestamptz;
ALTER TABLE tenants ADD CONSTRAINT tenants_held_not_opened CHECK (NOT (signup_held AND signup_opened_at IS NOT NULL));
CREATE INDEX tenants_signup_opened_idx ON tenants (signup_opened_at) WHERE signup_opened_at IS NOT NULL;

-- Today's businesses already made: those sign-up gave a run, and working first-sign-in businesses (their made-up c- address).
UPDATE tenants t SET signup_opened_at = t.created_at
 WHERE NOT t.signup_held AND NOT t.is_demo
   AND (EXISTS (SELECT 1 FROM signup_runs r WHERE r.tenant_id = t.id)
        OR (t.account_type = 'creator' AND t.slug ~ '^c-[0-9a-f]{10}$'));

/** Midnight in India: where the sign-up day starts. */
CREATE FUNCTION signup_day_start() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
$$;

/** Working businesses self-serve made today, leaving out `except_tenant` (the row a trigger is deciding about). */
CREATE FUNCTION signup_made_today(except_tenant integer DEFAULT NULL) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM tenants WHERE signup_opened_at >= signup_day_start() AND id IS DISTINCT FROM except_tenant
$$;

-- The exact check, in the transaction that opens the business, under one platform-wide lock (the same lock migration 911
-- took, and the one the sign-up module and the first sign-in take before they decide). The refusal names nobody.
CREATE FUNCTION tenants_signup_cap_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
BEGIN
  SELECT daily_cap INTO cap FROM signup_settings LIMIT 1;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bhava.signup_daily_cap'));
  SELECT daily_cap INTO cap FROM signup_settings LIMIT 1;
  IF cap IS NOT NULL AND signup_made_today(NEW.id) >= cap THEN
    RAISE EXCEPTION 'signup.daily_cap' USING ERRCODE = 'P0001', HINT = 'The daily cap on new businesses is reached.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_signup_cap_insert
  BEFORE INSERT ON tenants
  FOR EACH ROW
  WHEN (NEW.signup_opened_at IS NOT NULL)
  EXECUTE FUNCTION tenants_signup_cap_hold();

CREATE TRIGGER tenants_signup_cap_open
  BEFORE UPDATE OF signup_opened_at ON tenants
  FOR EACH ROW
  WHEN (OLD.signup_opened_at IS NULL AND NEW.signup_opened_at IS NOT NULL)
  EXECUTE FUNCTION tenants_signup_cap_hold();

-- Migration 911's guard on giving a run a business stays, on the same count: a run given a business that is not yet open
-- opens it, so the check above runs. A business already open (an adopted first-sign-in business) is not a new one.
CREATE OR REPLACE FUNCTION signup_cap_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tenants SET signup_opened_at = now() WHERE id = NEW.tenant_id AND signup_opened_at IS NULL;
  RETURN NEW;
END;
$$;
