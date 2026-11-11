-- Phase 4: shared shopper sign-in across stores (PRD 9.22, 9.18). A shopper who says yes, on the one consent screen that
-- names the platform, can reuse a verified phone or Google account and saved addresses at another store.
--
-- These tables belong to no business, have no tenant_id and no grant to the app role: business code cannot read them at
-- all. They are reached only through db.platform, by the shoppers module's shared-profile service, which hands a business
-- nothing but what its own checkout needs. They hold no order, no product, no store name and no count of anything.

-- The platform's own notice for the shared profile, numbered like the businesses' notices.
CREATE TABLE shared_consent_notices (
  version    integer PRIMARY KEY CHECK (version >= 1),
  body_en    text NOT NULL CHECK (length(body_en) BETWEEN 1 AND 4000),
  body_hi    text NOT NULL CHECK (length(body_hi) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One person across stores. Found by a keyed hash of the verified phone or the Google account id; the phone itself is
-- kept encrypted (DATA_KEY) so it can be offered back at checkout. Deleting the row is how consent is taken back (S-102).
CREATE TABLE shared_profiles (
  id                bigserial PRIMARY KEY,
  phone_hash        text UNIQUE CHECK (phone_hash IS NULL OR length(phone_hash) = 64),
  phone_enc         text NOT NULL DEFAULT '',
  google_hash       text UNIQUE CHECK (google_hash IS NULL OR length(google_hash) = 64),
  name_enc          text NOT NULL DEFAULT '',
  -- A label only (S-103). How it is worked out is in shared_cod_signals; nothing here says where or what.
  cod_risk          text NOT NULL DEFAULT 'none' CHECK (cod_risk IN ('none', 'elevated', 'high')),
  notice_version    integer NOT NULL REFERENCES shared_consent_notices(version),
  consented_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (phone_hash IS NOT NULL OR google_hash IS NOT NULL)
);

CREATE TABLE shared_addresses (
  id          bigserial PRIMARY KEY,
  profile_id  bigint NOT NULL REFERENCES shared_profiles(id) ON DELETE CASCADE,
  -- The whole address as one encrypted value: { name, phone, line1, line2, landmark, city, stateCode, pincode, kind }.
  address_enc text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_addresses_profile_idx ON shared_addresses (profile_id);
CREATE UNIQUE INDEX shared_addresses_default_idx ON shared_addresses (profile_id) WHERE is_default;

-- Which shopper row at which business is this person, so removing the profile can sign them out everywhere and a
-- business's own shopper can be matched back. Never shown to any business.
CREATE TABLE shared_profile_links (
  profile_id bigint NOT NULL REFERENCES shared_profiles(id) ON DELETE CASCADE,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id integer NOT NULL,
  linked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, tenant_id),
  UNIQUE (tenant_id, shopper_id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);

-- What the risk label is worked out from: cash-on-delivery parcels refused, per month, with no business on the row.
CREATE TABLE shared_cod_signals (
  profile_id bigint NOT NULL REFERENCES shared_profiles(id) ON DELETE CASCADE,
  month      date NOT NULL,
  delivered  integer NOT NULL DEFAULT 0 CHECK (delivered >= 0),
  refused    integer NOT NULL DEFAULT 0 CHECK (refused >= 0),
  PRIMARY KEY (profile_id, month)
);

-- That consent was given or taken back, and when. Kept after the profile is gone, as a hash only.
CREATE TABLE shared_consent_log (
  id             bigserial PRIMARY KEY,
  subject_hash   text NOT NULL CHECK (length(subject_hash) = 64),
  granted        boolean NOT NULL,
  notice_version integer NOT NULL REFERENCES shared_consent_notices(version),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_consent_log_subject_idx ON shared_consent_log (subject_hash, id DESC);
