-- Which plan has which Phase 4 feature (PRD 5.7, 9). Migration 004 already gave tier 3 and above store.checkout,
-- store.payments, store.shipping, store.inventory, store.invoices, store.reviews, store.wishlist, store.returns and
-- shopify.sync, and tiers 4 and 5 `loyalty`. On tier 3, loyalty is an add-on: a tenant_features row turns it on for that
-- business (9.21), and without it the loyalty API answers 403 (S-91).
WITH tiers (code, rank) AS (VALUES ('free', 0), ('t1', 1), ('t2', 2), ('t3', 3), ('t4', 4), ('t5', 5)),
ladder (feature, from_rank) AS (VALUES
  ('store.coupons', 3), ('store.cart_reminders', 3), ('store.order_alerts', 3), ('store.accounts', 3), ('store.shared_signin', 3)
)
INSERT INTO plan_features (plan_code, feature)
  SELECT tiers.code, ladder.feature FROM ladder JOIN tiers ON tiers.rank >= ladder.from_rank
  ON CONFLICT DO NOTHING;
