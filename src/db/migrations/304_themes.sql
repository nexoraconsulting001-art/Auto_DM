-- Phase 3: theme presets with their template slots (PRD 5.19), each business's theme choice on its brand kit (5.3), the
-- theme read from a business's website (8.9), and customisation requests triaged under the policy (5.18).

-- A preset fills the same slots as every other: shapes, pattern, reel frame, seal, ticker, heading flourish and card style.
-- Slot values are names from PRESET_SLOTS in src/contracts/themes.js, never CSS: the one layout turns them into styles, so a
-- new preset is a row (F-107) and can't carry markup or script onto a buyer page.
ALTER TABLE theme_presets
  ADD COLUMN made_for text NOT NULL DEFAULT '' CHECK (length(made_for) <= 80),
  ADD COLUMN active   boolean NOT NULL DEFAULT true,
  ADD COLUMN slots    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(slots) = 'object');

UPDATE theme_presets SET made_for = 'Fashion and ethnic wear', slots = '{
  "reelFrame": "arch", "photoShape": "arch", "cardStyle": "framed", "buttonStyle": "solid", "buttonCase": "upper", "radius": 4,
  "pattern": "none", "highlight": "underline", "flourish": "diamond", "sealIcon": "diamond", "ticker": "rule", "priceStyle": "display",
  "labelStyle": "plain", "logoShape": "arch", "offTag": "flat", "displayWeight": 700,
  "sealText": "Festive · Handpicked · Made in India", "tickerItems": ["Handpicked styles", "Made in India", "New arrivals every week", "Shop the look from the reel"]
}' WHERE code = 'utsav';
UPDATE theme_presets SET made_for = 'Beauty and skincare', slots = '{
  "reelFrame": "dewdrop", "photoShape": "circle", "cardStyle": "floating", "buttonStyle": "pill", "buttonCase": "none", "radius": 999,
  "pattern": "blush", "highlight": "italic", "flourish": "wave", "sealIcon": "drop", "ticker": "pill", "priceStyle": "body",
  "labelStyle": "plain", "logoShape": "circle", "offTag": "pill", "displayWeight": 400,
  "sealText": "Clean · Kind · Caring", "tickerItems": ["Picked for your skin", "Made in India", "New every week", "Shop the routine from the reel"]
}' WHERE code = 'dewdrop';
UPDATE theme_presets SET made_for = 'Food, home chefs and pantry', slots = '{
  "reelFrame": "tilted", "photoShape": "outlined", "cardStyle": "brutalist", "buttonStyle": "hard_shadow", "buttonCase": "none", "radius": 14,
  "pattern": "dots", "highlight": "marker", "flourish": "squiggle", "sealIcon": "pot", "ticker": "tilted", "priceStyle": "display",
  "labelStyle": "plain", "logoShape": "brutal", "offTag": "tilted", "displayWeight": 800,
  "sealText": "Fresh · Homemade · Small batch", "tickerItems": ["Small batch", "Family recipes", "Made fresh", "Shop it from the reel"]
}' WHERE code = 'tadka';
UPDATE theme_presets SET made_for = 'Gadgets, electronics and deals', slots = '{
  "reelFrame": "screen", "photoShape": "rounded", "cardStyle": "panel", "buttonStyle": "solid", "buttonCase": "none", "radius": 12,
  "pattern": "grid", "highlight": "color", "flourish": "arrow", "sealIcon": "bolt", "ticker": "band", "priceStyle": "neon",
  "labelStyle": "code", "logoShape": "square", "offTag": "code", "displayWeight": 700,
  "sealText": "Fresh deals · Fresh deals", "tickerItems": ["Fresh deals", "Tested picks", "New drops every week", "Shop the setup from the reel"]
}' WHERE code = 'gadget-galli';
UPDATE theme_presets SET made_for = 'Handmade, decor and home', slots = '{
  "reelFrame": "pebble", "photoShape": "leaf", "cardStyle": "stitched", "buttonStyle": "outline", "buttonCase": "none", "radius": 999,
  "pattern": "linen", "highlight": "italic", "flourish": "vine", "sealIcon": "leaf", "ticker": "stitched", "priceStyle": "display",
  "labelStyle": "plain", "logoShape": "leaf", "offTag": "pill", "displayWeight": 700,
  "sealText": "Handmade · Natural · Crafted", "tickerItems": ["Made by hand", "Natural materials", "Small makers", "Shop it from the reel"]
}' WHERE code = 'mitti';

-- The seller's own seal text and ticker (F-106): empty keeps the preset's. Where the look came from, whether our team should
-- check it (a JavaScript-only site keeps the preset plus logo, flagged), the contrast notes from the website read, and what
-- tuned the accent when there was no website.
ALTER TABLE brand_kits
  ADD COLUMN seal_text    text NOT NULL DEFAULT '' CHECK (length(seal_text) <= 60),
  ADD COLUMN ticker_items text[] NOT NULL DEFAULT '{}' CHECK (cardinality(ticker_items) <= 8),
  ADD COLUMN theme_source text NOT NULL DEFAULT 'preset' CHECK (theme_source IN ('preset', 'website')),
  ADD COLUMN theme_check  boolean NOT NULL DEFAULT false,
  ADD COLUMN theme_notes  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(theme_notes) <= 20),
  ADD COLUMN website      text NOT NULL DEFAULT '' CHECK (website = '' OR website ~ '^https?://' AND length(website) <= 500),
  ADD COLUMN accent_from  text NOT NULL DEFAULT '' CHECK (accent_from IN ('', 'logo', 'profile_photo', 'website'));

-- Each read of a business's website for its look (8.9, and the 5.5 brand read). Nothing is applied until it is reviewed.
CREATE TABLE theme_site_reads (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  website      text NOT NULL CHECK (website ~ '^https?://' AND length(website) <= 500),
  status       text NOT NULL CHECK (status IN ('read', 'script_only', 'failed', 'blocked')),
  colors       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(colors) = 'object'),
  heading_font text NOT NULL DEFAULT '' CHECK (length(heading_font) <= 80),
  body_font    text NOT NULL DEFAULT '' CHECK (length(body_font) <= 80),
  logo_url     text NOT NULL DEFAULT '' CHECK (length(logo_url) <= 2000),
  notes        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(notes) <= 20),
  applied_at   timestamptz,
  created_by   integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX theme_site_reads_list_idx ON theme_site_reads (tenant_id, id DESC);
CREATE INDEX theme_site_reads_created_by_idx ON theme_site_reads (tenant_id, created_by);
SELECT fence_tenant_table('theme_site_reads');

-- Platform only: a client's customisation request and how it was met (5.18). Triaged in the Platform Console to the lowest
-- level that does the job; a refusal keeps the alternative offered (F-100). Businesses have no access to it at all.
CREATE TABLE customisation_requests (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  summary      text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  level        integer CHECK (level IS NULL OR level BETWEEN 1 AND 5),
  others_want  boolean,
  decision     text NOT NULL DEFAULT 'open' CHECK (decision IN ('open', 'accepted', 'alternative', 'declined')),
  alternative  text NOT NULL DEFAULT '' CHECK (length(alternative) <= 1000),
  feature      text NOT NULL DEFAULT '' CHECK (length(feature) <= 80),        -- the flag a level 5 feature is built behind
  created_by   integer REFERENCES platform_users(id) ON DELETE SET NULL,
  decided_by   integer REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  CHECK (decision <> 'alternative' OR alternative <> '')
);
CREATE INDEX customisation_requests_tenant_idx ON customisation_requests (tenant_id, id DESC);
CREATE INDEX customisation_requests_created_by_idx ON customisation_requests (created_by);
CREATE INDEX customisation_requests_decided_by_idx ON customisation_requests (decided_by);
ALTER TABLE customisation_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON customisation_requests USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
