-- Phase 7: one Free plan per Instagram account, and the self-referral blocks and the once-only credit of seller referrals
-- (PRD 5.20; F-129). Track signup-plans, the signup and referrals folders. All of it is held here, in the database, so
-- two sign-ups at once, a repeated payment event or a module that forgets cannot get around it.

-- Every Instagram account each business has ever connected. free_claim marks a connection made while the business was
-- on the Free plan (or a business that later moved to Free with it): signup_settings.free_per_instagram is how many
-- businesses may hold one for the same account. Platform only: written by the triggers below, never by business code.
CREATE TABLE instagram_tenants (
  ig_user_id text NOT NULL CHECK (length(ig_user_id) BETWEEN 1 AND 80),
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  free_claim boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ig_user_id, tenant_id)
);
CREATE INDEX instagram_tenants_tenant_idx ON instagram_tenants (tenant_id);
ALTER TABLE instagram_tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON instagram_tenants USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- What is already connected counts as it stands (an older duplicate is kept, not refused).
INSERT INTO instagram_tenants (ig_user_id, tenant_id, free_claim)
  SELECT a.ig_user_id, a.tenant_id, t.plan = 'free' FROM ig_accounts a JOIN tenants t ON t.id = a.tenant_id
  ON CONFLICT DO NOTHING;

-- A payment method a business has paid with, as a keyed hash the billing module computes (never the card or UPI id
-- itself). Used only to refuse a referral between two businesses that pay the same way. Platform only.
CREATE TABLE seller_payment_marks (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mark_hash  text NOT NULL CHECK (mark_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, mark_hash)
);
CREATE INDEX seller_payment_marks_hash_idx ON seller_payment_marks (mark_hash);
ALTER TABLE seller_payment_marks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON seller_payment_marks USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- An Instagram account goes onto a business: the Free claim is counted under a lock on that account, so two sign-ups
-- connecting it at once cannot both take it, and a referral between two businesses that share it is blocked.
CREATE FUNCTION instagram_connected() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  is_free boolean;
  allowed integer;
  taken integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('instagram_tenants:' || NEW.ig_user_id));
  SELECT plan = 'free' INTO is_free FROM tenants WHERE id = NEW.tenant_id;
  is_free := COALESCE(is_free, false);
  IF is_free AND NOT EXISTS (SELECT 1 FROM instagram_tenants WHERE ig_user_id = NEW.ig_user_id AND tenant_id = NEW.tenant_id AND free_claim) THEN
    SELECT free_per_instagram INTO allowed FROM signup_settings;
    SELECT count(*) INTO taken FROM instagram_tenants WHERE ig_user_id = NEW.ig_user_id AND tenant_id <> NEW.tenant_id AND free_claim;
    IF taken >= COALESCE(allowed, 1) THEN
      RAISE EXCEPTION 'signup.free_taken' USING ERRCODE = 'unique_violation', DETAIL = 'This Instagram account already has a Free plan.';
    END IF;
  END IF;
  INSERT INTO instagram_tenants (ig_user_id, tenant_id, free_claim) VALUES (NEW.ig_user_id, NEW.tenant_id, is_free)
    ON CONFLICT (ig_user_id, tenant_id) DO UPDATE SET free_claim = instagram_tenants.free_claim OR EXCLUDED.free_claim;
  UPDATE seller_referrals r SET state = 'blocked', block_reason = 'same_instagram'
   WHERE r.state = 'pending'
     AND ((r.referred_tenant_id = NEW.tenant_id AND EXISTS (SELECT 1 FROM instagram_tenants m WHERE m.ig_user_id = NEW.ig_user_id AND m.tenant_id = r.tenant_id))
       OR (r.tenant_id = NEW.tenant_id AND EXISTS (SELECT 1 FROM instagram_tenants m WHERE m.ig_user_id = NEW.ig_user_id AND m.tenant_id = r.referred_tenant_id)));
  RETURN NULL;
END $$;
CREATE TRIGGER ig_accounts_connected AFTER INSERT ON ig_accounts FOR EACH ROW EXECUTE FUNCTION instagram_connected();

CREATE FUNCTION payment_mark_added() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE seller_referrals r SET state = 'blocked', block_reason = 'same_payment_method'
   WHERE r.state = 'pending'
     AND ((r.referred_tenant_id = NEW.tenant_id AND EXISTS (SELECT 1 FROM seller_payment_marks m WHERE m.mark_hash = NEW.mark_hash AND m.tenant_id = r.tenant_id))
       OR (r.tenant_id = NEW.tenant_id AND EXISTS (SELECT 1 FROM seller_payment_marks m WHERE m.mark_hash = NEW.mark_hash AND m.tenant_id = r.referred_tenant_id)));
  RETURN NULL;
END $$;
CREATE TRIGGER seller_payment_marks_added AFTER INSERT ON seller_payment_marks FOR EACH ROW EXECUTE FUNCTION payment_mark_added();

-- A change of plan. Starting a paid plan (the owner's change or the billing provider's, not a gift from the console or a
-- direct UPDATE) credits the business's referral, once: only a pending row is credited, so a repeated event finds
-- nothing to do. Moving to Free takes the Free claim for the Instagram accounts the business has.
CREATE FUNCTION plan_change_referrals() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.to_plan <> 'free' AND NEW.source IN ('owner', 'billing') THEN
    UPDATE seller_referrals
       SET state = 'credited', credited_at = now(), reward_paise = COALESCE((SELECT referral_reward_paise FROM billing_settings LIMIT 1), 0)
     WHERE referred_tenant_id = NEW.tenant_id AND state = 'pending';
  END IF;
  IF NEW.to_plan = 'free' AND NEW.from_plan <> 'free' THEN
    INSERT INTO instagram_tenants (ig_user_id, tenant_id, free_claim)
      SELECT ig_user_id, tenant_id, true FROM ig_accounts WHERE tenant_id = NEW.tenant_id
      ON CONFLICT (ig_user_id, tenant_id) DO UPDATE SET free_claim = true;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER plan_change_referrals AFTER INSERT ON plan_changes FOR EACH ROW EXECUTE FUNCTION plan_change_referrals();
