-- Phase 6 (PRD 10.7, 10.8): one branded shopper app per business. Owner: src/modules/app-config.
-- Colours and fonts are overrides only: a key not set here comes from the brand kit. The minimum version and store link per
-- platform are mirrored into app_min_versions, which stays the only thing the version gates read.
CREATE TABLE app_configs (
  tenant_id            integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  app_name             text NOT NULL DEFAULT '' CHECK (length(app_name) <= 30 AND app_name !~* 'bhava'),
  short_name           text NOT NULL DEFAULT '' CHECK (length(short_name) <= 12 AND short_name !~* 'bhava'),
  android_package      text CHECK (android_package IS NULL OR (android_package ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,5}$' AND length(android_package) <= 150 AND android_package !~ 'bhava')),
  ios_bundle_id        text CHECK (ios_bundle_id IS NULL OR (ios_bundle_id ~ '^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){1,5}$' AND length(ios_bundle_id) <= 155 AND ios_bundle_id !~* 'bhava')),
  url_scheme           text CHECK (url_scheme IS NULL OR (url_scheme ~ '^[a-z][a-z0-9]{2,30}$' AND url_scheme !~ 'bhava')),
  icon_media_id        uuid,
  splash_media_id      uuid,
  splash_background    text NOT NULL DEFAULT '' CHECK (splash_background = '' OR splash_background ~ '^#[0-9A-Fa-f]{6}$'),
  colors               jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(colors) = 'object'),
  heading_font         text NOT NULL DEFAULT '' CHECK (length(heading_font) <= 80),
  body_font            text NOT NULL DEFAULT '' CHECK (length(body_font) <= 80),
  shop_domain          text NOT NULL DEFAULT '' CHECK (length(shop_domain) <= 253),
  support_email        text NOT NULL DEFAULT '' CHECK (length(support_email) <= 254),
  privacy_url          text NOT NULL DEFAULT '' CHECK (privacy_url = '' OR (privacy_url ~ '^https://' AND length(privacy_url) <= 500)),
  apple_team_id        text NOT NULL DEFAULT '' CHECK (apple_team_id = '' OR apple_team_id ~ '^[A-Z0-9]{10}$'),
  play_account_id      text NOT NULL DEFAULT '' CHECK (play_account_id = '' OR play_account_id ~ '^[0-9]{6,25}$'),
  -- Google Play App Signing's certificate fingerprints, for assetlinks.json. Not a secret.
  play_signing_sha256  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(play_signing_sha256) <= 5 AND (cardinality(play_signing_sha256) = 0
                         OR array_to_string(play_signing_sha256, ',') ~ '^([0-9A-F]{2}:){31}[0-9A-F]{2}(,([0-9A-F]{2}:){31}[0-9A-F]{2})*$')),
  android_min_version  text NOT NULL DEFAULT '' CHECK (android_min_version = '' OR android_min_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'),
  android_store_url    text NOT NULL DEFAULT '' CHECK (android_store_url = '' OR android_store_url ~ '^https://play\.google\.com/store/apps/details\?id='),
  ios_min_version      text NOT NULL DEFAULT '' CHECK (ios_min_version = '' OR ios_min_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'),
  ios_store_url        text NOT NULL DEFAULT '' CHECK (ios_store_url = '' OR ios_store_url ~ '^https://apps\.apple\.com/'),
  android_next_build   integer NOT NULL DEFAULT 1 CHECK (android_next_build >= 1),
  ios_next_build       integer NOT NULL DEFAULT 1 CHECK (ios_next_build >= 1),
  -- Set by the database when the first build of that platform is submitted (app_builds_lock_ids, 602).
  android_locked_at    timestamptz,
  ios_locked_at        timestamptz,
  -- Demo access for store review (2.1(a)): the number and the hash of its code; the code itself is never stored.
  review_phone         text CHECK (review_phone IS NULL OR review_phone ~ '^\+[1-9][0-9]{7,14}$'),
  review_code_hash     text,
  review_enabled       boolean NOT NULL DEFAULT false,
  validation           jsonb NOT NULL DEFAULT '{}',   -- { ok, checkedAt, problems: [{ field, code, message, platform }] }
  validated_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, icon_media_id) REFERENCES media(tenant_id, id) ON DELETE SET NULL (icon_media_id),
  FOREIGN KEY (tenant_id, splash_media_id) REFERENCES media(tenant_id, id) ON DELETE SET NULL (splash_media_id)
);
-- Across every business: two brands can never hold the same package, bundle id or link scheme.
CREATE UNIQUE INDEX app_configs_package_key ON app_configs (lower(android_package)) WHERE android_package IS NOT NULL;
CREATE UNIQUE INDEX app_configs_bundle_key ON app_configs (lower(ios_bundle_id)) WHERE ios_bundle_id IS NOT NULL;
CREATE UNIQUE INDEX app_configs_scheme_key ON app_configs (url_scheme) WHERE url_scheme IS NOT NULL;
SELECT fence_tenant_table('app_configs');

-- The ids a store knows the app by never change after its first submitted build; build numbers never go down.
CREATE FUNCTION app_configs_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.android_locked_at IS NOT NULL AND NEW.android_locked_at IS NULL) OR (OLD.ios_locked_at IS NOT NULL AND NEW.ios_locked_at IS NULL) THEN
    RAISE EXCEPTION 'A store lock is never lifted' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_configs_locked';
  END IF;
  IF OLD.android_locked_at IS NOT NULL AND NEW.android_package IS DISTINCT FROM OLD.android_package THEN
    RAISE EXCEPTION 'The Android package cannot change after a build was submitted' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_configs_locked';
  END IF;
  IF OLD.ios_locked_at IS NOT NULL AND NEW.ios_bundle_id IS DISTINCT FROM OLD.ios_bundle_id THEN
    RAISE EXCEPTION 'The iOS bundle id cannot change after a build was submitted' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_configs_locked';
  END IF;
  IF (OLD.android_locked_at IS NOT NULL OR OLD.ios_locked_at IS NOT NULL) AND NEW.url_scheme IS DISTINCT FROM OLD.url_scheme THEN
    RAISE EXCEPTION 'The link scheme cannot change after a build was submitted' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_configs_locked';
  END IF;
  IF NEW.android_next_build < OLD.android_next_build OR NEW.ios_next_build < OLD.ios_next_build THEN
    RAISE EXCEPTION 'Build numbers never go down' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_configs_locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_configs_locked BEFORE UPDATE ON app_configs FOR EACH ROW EXECUTE FUNCTION app_configs_locked();

-- Definer rights: app_min_versions is the platform's alone, and the version gates read only it.
CREATE FUNCTION app_configs_mirror_minimum() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_platform text;
  v_min text;
  v_url text;
BEGIN
  FOREACH v_platform IN ARRAY ARRAY['android', 'ios'] LOOP
    IF v_platform = 'android' THEN
      v_min := NEW.android_min_version;
      v_url := NEW.android_store_url;
    ELSE
      v_min := NEW.ios_min_version;
      v_url := NEW.ios_store_url;
    END IF;
    IF v_min <> '' AND v_url <> '' THEN
      UPDATE app_min_versions SET min_version = v_min, store_url = v_url, updated_at = now()
      WHERE app = 'shopper' AND tenant_id = NEW.tenant_id AND platform = v_platform;
      IF NOT FOUND THEN
        INSERT INTO app_min_versions (app, tenant_id, platform, min_version, store_url) VALUES ('shopper', NEW.tenant_id, v_platform, v_min, v_url);
      END IF;
    ELSE
      DELETE FROM app_min_versions WHERE app = 'shopper' AND tenant_id = NEW.tenant_id AND platform = v_platform;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER app_configs_mirror_minimum AFTER INSERT OR UPDATE OF android_min_version, android_store_url, ios_min_version, ios_store_url ON app_configs
  FOR EACH ROW EXECUTE FUNCTION app_configs_mirror_minimum();
