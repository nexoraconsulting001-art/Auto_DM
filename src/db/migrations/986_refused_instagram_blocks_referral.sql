-- R3-MONEY-8 (F-129): a self-referral by the same Instagram account is never credited. Migration 741 blocks it when the
-- referred business's ig_accounts row is inserted, but since tenancy-1 (b22238e) an account another business holds is
-- refused at connect (claimConnection) and no row is ever inserted for the second business: the block never ran, and the
-- referral was credited at the first paid plan. Instagram connect now calls this when it refuses an account held by
-- another business, with the same rule as the trigger: a pending referral between this business and any business that
-- has had this Instagram account is blocked (same_instagram).
CREATE FUNCTION block_same_instagram_referrals(p_ig_user_id text, p_tenant_id integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  UPDATE seller_referrals r SET state = 'blocked', block_reason = 'same_instagram'
   WHERE r.state = 'pending'
     AND ((r.referred_tenant_id = p_tenant_id AND EXISTS (SELECT 1 FROM instagram_tenants m WHERE m.ig_user_id = p_ig_user_id AND m.tenant_id = r.tenant_id))
       OR (r.tenant_id = p_tenant_id AND EXISTS (SELECT 1 FROM instagram_tenants m WHERE m.ig_user_id = p_ig_user_id AND m.tenant_id = r.referred_tenant_id)));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION block_same_instagram_referrals(text, integer) FROM PUBLIC;
