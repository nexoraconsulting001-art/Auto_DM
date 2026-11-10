-- Phase 0: each business's look on buyer pages (PRD 5.3, 5.19). A preset is a row, so a new one needs no code.

CREATE TABLE theme_presets (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z0-9-]+$'),
  name         text NOT NULL,
  position     integer NOT NULL DEFAULT 0,
  colors       jsonb NOT NULL,
  heading_font text NOT NULL,
  body_font    text NOT NULL
);

INSERT INTO theme_presets (code, name, position, colors, heading_font, body_font) VALUES
  ('utsav', 'Utsav', 1, '{"ground":"#FBF6EE","card":"#FFFFFF","ink":"#2A0F18","muted":"#6E4F58","line":"#EADBCB","primary":"#7A1F3D","on_primary":"#FFFFFF","accent":"#D4AF37","on_accent":"#2A0F18","eyebrow":"#7A1F3D"}', 'Cormorant Garamond', 'Jost'),
  ('dewdrop', 'Dewdrop', 2, '{"ground":"#FFF5F6","card":"#FFFFFF","ink":"#3A1626","muted":"#7A5363","line":"#F4D9E0","primary":"#A3355A","on_primary":"#FFFFFF","accent":"#F9C9D4","on_accent":"#3A1626","eyebrow":"#A3355A"}', 'DM Serif Display', 'Manrope'),
  ('tadka', 'Tadka', 3, '{"ground":"#FFF8E6","card":"#FFFFFF","ink":"#2B1406","muted":"#6B4A33","line":"#2B1406","primary":"#B4340F","on_primary":"#FFFFFF","accent":"#F6C343","on_accent":"#2B1406","eyebrow":"#B4340F"}', 'Bricolage Grotesque', 'Nunito'),
  ('gadget-galli', 'Gadget Galli', 4, '{"ground":"#0E1120","card":"#161A2D","ink":"#EEF1FF","muted":"#A7AECB","line":"#262B45","primary":"#3D62F2","on_primary":"#FFFFFF","accent":"#B8F35A","on_accent":"#0E1120","eyebrow":"#B8F35A"}', 'Space Grotesk', 'Inter'),
  ('mitti', 'Mitti', 5, '{"ground":"#F4EFE6","card":"#FFFDF9","ink":"#2E2A22","muted":"#6A6252","line":"#D9CDB8","primary":"#4E5D3A","on_primary":"#FFFFFF","accent":"#E3A47D","on_accent":"#2E2A22","eyebrow":"#8A4B2A"}', 'Lora', 'Work Sans');

-- No row means the default preset with nothing changed. Colours and fonts here override the preset's.
CREATE TABLE brand_kits (
  tenant_id     integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  preset        text NOT NULL DEFAULT 'utsav' REFERENCES theme_presets(code),
  logo_url      text NOT NULL DEFAULT '',
  logo_dark_url text NOT NULL DEFAULT '',
  favicon_url   text NOT NULL DEFAULT '',
  colors        jsonb NOT NULL DEFAULT '{}',
  heading_font  text NOT NULL DEFAULT '',
  body_font     text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The logo and accent colour used to be plain settings.
INSERT INTO brand_kits (tenant_id, logo_url)
  SELECT tenant_id, value FROM settings WHERE key = 'logo_url' AND value <> '';
INSERT INTO brand_kits (tenant_id, colors)
  SELECT tenant_id, jsonb_build_object('accent', value) FROM settings WHERE key = 'accent_color' AND value ~ '^#[0-9A-Fa-f]{6}$'
  ON CONFLICT (tenant_id) DO UPDATE SET colors = EXCLUDED.colors;
DELETE FROM settings WHERE key IN ('logo_url', 'accent_color');
