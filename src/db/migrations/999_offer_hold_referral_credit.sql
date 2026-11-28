-- R7-MONEY-2 (M-8): a launch-offer place was taken when the owner picked a paid plan, before any payment, and never given
-- back. A place is now held for billing_settings.offer_hold_hours while the owner pays (offer_claims.hold_until), made final
-- by the first captured payment (confirm_offer), and given back when the hold runs out unpaid or the unpaid subscription
-- ends (release_offer_hold). A held place counts in offers.claimed like a final one, so the 101st owner is still refused
-- while 100 are paying.
ALTER TABLE billing_settings ADD COLUMN offer_hold_hours integer NOT NULL DEFAULT 24 CHECK (offer_hold_hours BETWEEN 1 AND 720);
ALTER TABLE offer_claims ADD COLUMN hold_until timestamptz;
CREATE INDEX offer_claims_hold_idx ON offer_claims (hold_until) WHERE hold_until IS NOT NULL;

-- A place already taken by a business that has paid stays its own; one taken by a business that never paid becomes a hold
-- from now, so it is given back if it is still unpaid when the hold runs out.
UPDATE offer_claims c SET hold_until = now() + make_interval(hours => (SELECT offer_hold_hours FROM billing_settings LIMIT 1))
 WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = c.tenant_id AND s.current_period_end IS NOT NULL);

-- True when the current business now holds the offer (it already did, or took one of the places left); false when the offer
-- is full, switched off or unknown. A new place is a hold; asking again while paying renews a hold, never a final place.
CREATE OR REPLACE FUNCTION claim_offer(p_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  business integer := current_tenant_id();
  hold interval := make_interval(hours => COALESCE((SELECT offer_hold_hours FROM billing_settings LIMIT 1), 24));
BEGIN
  IF business IS NULL THEN
    RAISE EXCEPTION 'claim_offer needs a current business';
  END IF;
  PERFORM 1 FROM offers WHERE code = p_code FOR UPDATE;
  IF EXISTS (SELECT 1 FROM offer_claims WHERE tenant_id = business AND offer_code = p_code) THEN
    UPDATE offer_claims SET hold_until = now() + hold WHERE tenant_id = business AND offer_code = p_code AND hold_until IS NOT NULL;
    RETURN true;
  END IF;
  UPDATE offers SET claimed = claimed + 1 WHERE code = p_code AND active AND claimed < max_accounts;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO offer_claims (tenant_id, offer_code, hold_until) VALUES (business, p_code, now() + hold);
  RETURN true;
END $$;

-- The first captured payment: the current business's place becomes final. A hold already given back is taken again if a
-- place is left. False when none is (the payment was at the offer price all the same: billing tells ops).
CREATE FUNCTION confirm_offer(p_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  business integer := current_tenant_id();
BEGIN
  IF business IS NULL THEN
    RAISE EXCEPTION 'confirm_offer needs a current business';
  END IF;
  PERFORM 1 FROM offers WHERE code = p_code FOR UPDATE;
  UPDATE offer_claims SET hold_until = NULL WHERE tenant_id = business AND offer_code = p_code;
  IF FOUND THEN
    RETURN true;
  END IF;
  UPDATE offers SET claimed = claimed + 1 WHERE code = p_code AND claimed < max_accounts;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO offer_claims (tenant_id, offer_code) VALUES (business, p_code);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION confirm_offer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_offer(text) TO bhava_app;

-- Gives back the current business's held (never a final) place: any hold, or with p_expired_only only one that has run
-- out. True when a place was given back.
CREATE FUNCTION release_offer_hold(p_code text, p_expired_only boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  business integer := current_tenant_id();
BEGIN
  IF business IS NULL THEN
    RAISE EXCEPTION 'release_offer_hold needs a current business';
  END IF;
  PERFORM 1 FROM offers WHERE code = p_code FOR UPDATE;
  DELETE FROM offer_claims WHERE tenant_id = business AND offer_code = p_code AND hold_until IS NOT NULL AND (NOT p_expired_only OR hold_until <= now());
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE offers SET claimed = claimed - 1 WHERE code = p_code AND claimed > 0;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION release_offer_hold(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_offer_hold(text, boolean) TO bhava_app;
