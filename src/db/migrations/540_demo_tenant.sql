-- Phase 5 (PRD 10.6, 5.11): the business App Review signs in to. It is an ordinary business made and refreshed by
-- src/modules/demo-tenant, marked by one flag and never by its id, slug or name. Everything the flag means is here, in
-- the database, so no other code has to ask "is this the demo business?":
--
--   - It never sends. Its compliance settings stay paused by ops with dry run on and the store closed, whoever writes
--     them, so the engine holds every DM and reply (paused.tenant) and nothing can lift it.
--   - It holds no real account. Its Instagram accounts are made up (ids beginning "sample-", which no Instagram id
--     does) and never hold a token, so nothing ever calls Meta for it; a Facebook Page or a WhatsApp account can't
--     be added at all.
--   - It is reached by the review login only. Once it exists, review_logins names it and nothing else, no other business
--     may hold an account of the review number's person, and no membership ties an account in it to another business.
--
-- Billing, metering and platform totals (Phase 7) count counted_tenants, which leaves it out; no other code reads the flag.

ALTER TABLE tenants ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
-- One demo business at most.
CREATE UNIQUE INDEX tenants_one_demo_idx ON tenants (is_demo) WHERE is_demo;

-- What the module last wrote, so it knows when the sample is out of date. Written through db.platform only.
CREATE TABLE demo_samples (
  tenant_id  integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  version    integer NOT NULL CHECK (version > 0),
  -- "Today" for the sample: every date in it is counted back from this day.
  anchor_day date NOT NULL,
  -- sha256 of the sample as written: two fills with the same digest wrote the same rows.
  digest     text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  filled_at  timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('demo_samples', 'SELECT');

-- Definer rights: the triggers below run for the app's login too, which sees only its own row of tenants and no people.
CREATE FUNCTION tenant_is_demo(tid integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT is_demo FROM tenants WHERE id = tid), false)
$$;
CREATE FUNCTION demo_tenant_id() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM tenants WHERE is_demo LIMIT 1
$$;
-- True when pid holds the review number and tid is not the business the review login opens (the demo one, once it exists).
CREATE FUNCTION review_person_elsewhere(pid bigint, tid integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM person_identities i JOIN review_logins r ON r.phone = i.subject WHERE i.kind = 'phone' AND i.person_id = pid AND r.tenant_id IS DISTINCT FROM tid)
$$;
REVOKE ALL ON FUNCTION tenant_is_demo(integer), demo_tenant_id(), review_person_elsewhere(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_is_demo(integer), demo_tenant_id(), review_person_elsewhere(bigint, integer) TO bhava_app;

-- What billing, metering and platform totals count (Phase 7): every business but the demo one.
CREATE VIEW counted_tenants AS SELECT * FROM tenants WHERE NOT is_demo;

-- Sending stays off, and the owner, ops or a support resume cannot turn it on.
CREATE FUNCTION demo_compliance_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF tenant_is_demo(NEW.tenant_id) THEN
    NEW.paused := true;
    NEW.paused_by := 'ops';
    NEW.pause_reason := 'Demo business: sample data only. Nothing is ever sent.';
    NEW.paused_at := COALESCE(NEW.paused_at, now());
    NEW.pause_store := true;
    NEW.dry_run := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_settings_demo BEFORE INSERT OR UPDATE ON compliance_settings
  FOR EACH ROW EXECUTE FUNCTION demo_compliance_settings();

-- A made-up account, never a token and never "active": it is shown as unavailable and no job picks it up.
CREATE FUNCTION demo_ig_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF tenant_is_demo(NEW.tenant_id) THEN
    IF NEW.ig_user_id !~ '^sample-' THEN
      RAISE EXCEPTION 'A demo business connects no real Instagram account' USING ERRCODE = 'check_violation', CONSTRAINT = 'ig_accounts_demo';
    END IF;
    NEW.access_token_enc := '';
    NEW.token_updated_at := NULL;
    NEW.token_expires_at := NULL;
    NEW.next_refresh_at := NULL;
    IF NEW.status = 'active' THEN NEW.status := 'reconnect_needed'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ig_accounts_demo BEFORE INSERT OR UPDATE ON ig_accounts
  FOR EACH ROW EXECUTE FUNCTION demo_ig_accounts();

CREATE FUNCTION demo_no_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF tenant_is_demo(NEW.tenant_id) THEN
    RAISE EXCEPTION 'A demo business connects no % account', TG_ARGV[0] USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_demo';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fb_pages_demo BEFORE INSERT OR UPDATE ON fb_pages
  FOR EACH ROW EXECUTE FUNCTION demo_no_account('Facebook');
CREATE TRIGGER whatsapp_accounts_demo BEFORE INSERT OR UPDATE ON whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION demo_no_account('WhatsApp');

-- A membership is a door between two businesses. None is ever written into or out of the demo business, whatever
-- proof a sign-in brings, so the review login reaches nothing else. Skipped, not refused: the other half of a
-- person's sign-in still links their real businesses.
CREATE FUNCTION demo_memberships() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF tenant_is_demo(NEW.tenant_id) OR tenant_is_demo(NEW.member_tenant_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_demo BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION demo_memberships();

-- Once a demo business exists, a review login names it: an empty one is filled in, and another business is refused.
-- With none yet the login opens nothing (accounts treats a login with no business as switched off).
CREATE FUNCTION demo_review_logins() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  demo integer := demo_tenant_id();
BEGIN
  IF demo IS NULL THEN RETURN NEW; END IF;
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := demo;
  ELSIF NEW.tenant_id <> demo THEN
    RAISE EXCEPTION 'The review login opens the demo business only' USING ERRCODE = 'check_violation', CONSTRAINT = 'review_logins_demo';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_logins_demo BEFORE INSERT OR UPDATE ON review_logins
  FOR EACH ROW EXECUTE FUNCTION demo_review_logins();

-- The review person's account lives in the demo business only: no other business may hold an account tied to them,
-- so neither switching business nor an invitation to the review number opens anything else.
CREATE FUNCTION demo_users() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.person_id IS NOT NULL AND review_person_elsewhere(NEW.person_id, NEW.tenant_id) THEN
    RAISE EXCEPTION 'The review login opens the demo business only' USING ERRCODE = 'check_violation', CONSTRAINT = 'users_review_demo';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_review_demo BEFORE INSERT OR UPDATE OF person_id, tenant_id ON users
  FOR EACH ROW EXECUTE FUNCTION demo_users();
