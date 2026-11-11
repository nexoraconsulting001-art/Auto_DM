-- Phase 5 (PRD 5.11, 10.3, 10.6): one person, many businesses, and no passwords.
--
-- A person is one human. They prove who they are with an identity (a phone that received a WhatsApp code, a Google
-- account, an Apple account) and that proof, never a typed phone number, is what ties their seller accounts in
-- different businesses together. Everything here is about no single business: no tenant_id, no grant to bhava_app,
-- reached only through db.platform.

CREATE TABLE people (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set when "Delete my account" completes: every identity is gone by then and the row stays only for the audit trail.
  deleted_at timestamptz
);

-- kind and subject together are unique, so one phone, Google account or Apple account is exactly one person.
-- A phone's subject is the number in E.164 (+919876543210); Google's and Apple's is the token's "sub".
CREATE TABLE person_identities (
  id          bigserial PRIMARY KEY,
  person_id   bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('phone', 'google', 'apple')),
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  -- The provider's verified email, kept to match an invitation sent to an email address. Empty for a phone.
  email       text NOT NULL DEFAULT '',
  verified_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, subject),
  CHECK (kind <> 'phone' OR subject ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE INDEX person_identities_person_idx ON person_identities (person_id);

-- One-time codes for sellers. Neither the number nor the code is stored: subject_hash and code_hash are keyed hashes
-- (src/contracts/accounts.js). A row is written for a number nobody has, too, so both get the same answer.
-- attempts stops at 5 in the database: a sixth wrong try cannot be recorded, so it cannot be allowed either.
CREATE TABLE seller_login_codes (
  id           bigserial PRIMARY KEY,
  subject_hash text NOT NULL,
  code_hash    text NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('signin', 'reauth', 'link')),
  -- Who asked, for reauth and link: the code then works only in that person's session.
  person_id    bigint REFERENCES people(id) ON DELETE CASCADE,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (purpose = 'signin' OR person_id IS NOT NULL)
);
CREATE INDEX seller_login_codes_subject_idx ON seller_login_codes (subject_hash, purpose, created_at DESC);
CREATE INDEX seller_login_codes_expiry_idx ON seller_login_codes (expires_at);

-- App Review's fixed login (PRD 5.11, 10.6): one number, the hash of its code, and a flag. It opens the demo business only.
CREATE TABLE review_logins (
  id         serial PRIMARY KEY,
  phone      text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash  text NOT NULL,
  enabled    boolean NOT NULL DEFAULT false,
  tenant_id  integer REFERENCES tenants(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every time the review code is tried, on any number, accepted or not. Rows are only ever added; none holds a number or a code.
CREATE TABLE review_login_uses (
  id           bigserial PRIMARY KEY,
  subject_hash text NOT NULL,
  accepted     boolean NOT NULL,
  reason       text NOT NULL DEFAULT '' CHECK (reason IN ('', 'wrong_number', 'flag_off', 'wrong_code')),
  ip_hash      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (accepted = (reason = ''))
);
CREATE INDEX review_login_uses_time_idx ON review_login_uses (created_at);

-- "Delete my account" (Apple 5.1.1(v)): the request, when it will be carried out, and how it ended.
CREATE TABLE account_deletion_requests (
  id           bigserial PRIMARY KEY,
  person_id    bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'cancelled', 'completed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (due_at >= requested_at)
);
CREATE UNIQUE INDEX account_deletion_open_idx ON account_deletion_requests (person_id) WHERE status = 'requested';

-- A seller account belongs to a person once that person has proved it is theirs: a verified phone equal to the
-- account's phone, or an invitation accepted with a verified identity. Until then person_id is empty and the account
-- cannot be reached without a password. removed_at is "removed from the team": the row stays for the audit trail and
-- the orders it touched, and every lookup of a signed-in account leaves it out.
ALTER TABLE users ADD COLUMN person_id bigint REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN removed_at timestamptz;
CREATE INDEX users_person_idx ON users (person_id) WHERE person_id IS NOT NULL;

-- Seller (a business) or Creator (a person sharing links, PRD 5.20). Same plans, roles and app either way.
ALTER TABLE tenants ADD COLUMN account_type text NOT NULL DEFAULT 'seller' CHECK (account_type IN ('seller', 'creator'));
