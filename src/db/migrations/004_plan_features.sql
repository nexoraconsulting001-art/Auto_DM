-- Phase 0: what each plan includes (PRD 3). A higher plan keeps what the lower ones have. limit_value NULL means no limit.

WITH tiers (code, rank) AS (VALUES ('free', 0), ('t1', 1), ('t2', 2), ('t3', 3), ('t4', 4), ('t5', 5)),
ladder (feature, from_rank) AS (VALUES
  -- every plan
  ('triggers.comment', 0), ('links.two_tap', 0), ('creator_page', 0), ('analytics', 0), ('reach_guard', 0), ('owner_app', 0),
  -- Tier 1 Automation
  ('links.one_tap', 1), ('facebook', 1), ('brand_kit', 1), ('custom_domain', 1),
  -- Tier 2 Catalog
  ('catalog', 2), ('landing_pages', 2), ('shop_page', 2), ('link_in_bio', 2), ('lead_form', 2), ('report.monthly', 2),
  -- Tier 3 Store
  ('triggers.story_dm', 3), ('store.checkout', 3), ('store.payments', 3), ('store.shipping', 3), ('store.inventory', 3),
  ('store.invoices', 3), ('store.reviews', 3), ('store.wishlist', 3), ('store.returns', 3), ('shopify.sync', 3),
  -- Tiers 4 and 5, the apps
  ('loyalty', 4), ('app.android', 4), ('app.ios', 5)
)
INSERT INTO plan_features (plan_code, feature)
  SELECT tiers.code, ladder.feature FROM ladder JOIN tiers ON tiers.rank >= ladder.from_rank;

INSERT INTO plan_features (plan_code, feature, limit_value) VALUES
  ('free', 'automations', 3), ('t1', 'automations', NULL), ('t2', 'automations', NULL),
  ('t3', 'automations', NULL), ('t4', 'automations', NULL), ('t5', 'automations', NULL),

  ('free', 'dms.monthly', 500), ('t1', 'dms.monthly', 5000), ('t2', 'dms.monthly', 15000),
  ('t3', 'dms.monthly', 50000), ('t4', 'dms.monthly', 50000), ('t5', 'dms.monthly', 50000),

  ('free', 'insights.days', 7), ('t1', 'insights.days', NULL), ('t2', 'insights.days', NULL),
  ('t3', 'insights.days', NULL), ('t4', 'insights.days', NULL), ('t5', 'insights.days', NULL),

  ('free', 'reel.products', 1), ('t1', 'reel.products', 1), ('t2', 'reel.products', 20),
  ('t3', 'reel.products', 20), ('t4', 'reel.products', 20), ('t5', 'reel.products', 20),

  -- Free only.
  ('free', 'badge.made_with', NULL);
