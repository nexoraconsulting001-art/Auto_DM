-- Phase 6 (PRD 10.7, 10.14 P-63): where an order was placed, and coupons for the app only. Owner: src/modules/app-api.
-- The channel is set by the server from the session (currentChannel(), src/platform/channel.js), never from a request body:
-- "in the app" means the request carried a valid app access token.
ALTER TABLE coupons ADD COLUMN app_only boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'app'));

CREATE FUNCTION orders_channel_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel IS DISTINCT FROM OLD.channel THEN
    RAISE EXCEPTION 'Where an order was placed never changes' USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_channel_fixed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_channel_fixed BEFORE UPDATE OF channel ON orders FOR EACH ROW EXECUTE FUNCTION orders_channel_fixed();

-- The database's lock behind the coupon rules: an app-only coupon is never redeemed on an order placed on the web.
CREATE FUNCTION coupon_redemptions_app_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM coupons c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.coupon_id AND c.app_only)
     AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id AND o.channel = 'app') THEN
    RAISE EXCEPTION 'This offer works only in the app' USING ERRCODE = 'check_violation', CONSTRAINT = 'coupon_app_only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coupon_redemptions_app_only BEFORE INSERT ON coupon_redemptions FOR EACH ROW EXECUTE FUNCTION coupon_redemptions_app_only();
