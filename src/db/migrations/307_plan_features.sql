-- Which plan has which Phase 3 feature. From migration 004: catalog, landing_pages, shop_page, link_in_bio and lead_form from
-- tier 2, creator_page on every plan, badge.made_with on the free plan only, and reel.products (1 below tier 2, then 20).
-- The lead form is an add-on on tier 1: a tenant_features row turns it on for that business (8.15).
WITH tiers (code, rank) AS (VALUES ('free', 0), ('t1', 1), ('t2', 2), ('t3', 3), ('t4', 4), ('t5', 5)),
ladder (feature, from_rank) AS (VALUES
  ('catalog.import', 2), ('whatsapp_order', 2), ('category_sequences', 2), ('theme_presets', 0)
)
INSERT INTO plan_features (plan_code, feature)
  SELECT tiers.code, ladder.feature FROM ladder JOIN tiers ON tiers.rank >= ladder.from_rank;
