-- Phase 9 (go-live, G-17): the daily cap on new businesses holds under parallel sign-ups.
-- The sign-up module reads the day's count before it makes a business, so two sign-ups in the same instant could both
-- pass the last place. This trigger takes one lock for the whole platform and counts again in the transaction that
-- gives a sign-up run its business, so the cap can never be passed. The refusal names no person and no business.
CREATE OR REPLACE FUNCTION signup_cap_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  made integer;
BEGIN
  SELECT daily_cap INTO cap FROM signup_settings LIMIT 1;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  -- One sign-up at a time past this point, until its transaction ends; the count below then sees every one before it.
  PERFORM pg_advisory_xact_lock(hashtext('bhava.signup_daily_cap'));
  SELECT daily_cap INTO cap FROM signup_settings LIMIT 1;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*)::int INTO made
    FROM signup_runs r JOIN tenants t ON t.id = r.tenant_id
   WHERE r.id <> NEW.id
     AND t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata');
  IF made >= cap THEN
    RAISE EXCEPTION 'signup.daily_cap' USING ERRCODE = 'P0001', HINT = 'The daily cap on new businesses is reached.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signup_runs_cap_hold
  BEFORE UPDATE OF tenant_id ON signup_runs
  FOR EACH ROW
  WHEN (OLD.tenant_id IS NULL AND NEW.tenant_id IS NOT NULL)
  EXECUTE FUNCTION signup_cap_hold();
