-- Phase 3: the lead form (PRD 8.15). A lead is a first name, a phone number or an email, where it came from, and the consent
-- given, by channel, against the exact text the shopper saw. Nothing else is collected: there is no column for an IP address,
-- a device or a message. Consent records, withdrawal, deletion and retention follow 9.18.

-- Whether the form shows on each surface, with the optional offer line above it.
CREATE TABLE lead_forms (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  surface    text NOT NULL CHECK (surface IN ('landing', 'creator', 'store')),
  enabled    boolean NOT NULL DEFAULT false,
  offer_line text NOT NULL DEFAULT '' CHECK (length(offer_line) <= 160),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, surface)
);
SELECT fence_tenant_table('lead_forms');

-- Every consent wording a business has shown, numbered. A lead points at the one its shopper agreed to; a version is never
-- changed, only followed by a new one.
CREATE TABLE lead_consent_texts (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version    integer NOT NULL CHECK (version >= 1),
  body       text NOT NULL CHECK (length(body) BETWEEN 10 AND 600),
  channels   text[] NOT NULL CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY['whatsapp', 'sms', 'email', 'call']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version)
);
SELECT fence_tenant_table('lead_consent_texts', 'SELECT, INSERT');

CREATE TABLE leads (
  id                 serial PRIMARY KEY,
  tenant_id          integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name         text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
  phone              text NOT NULL DEFAULT '' CHECK (phone = '' OR phone ~ '^\+[1-9][0-9]{7,14}$'),       -- international format
  email              text NOT NULL DEFAULT '' CHECK (email = '' OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  source             text NOT NULL CHECK (source IN ('landing', 'creator', 'store', 'bio')),
  source_ref         text NOT NULL DEFAULT '' CHECK (length(source_ref) <= 200),                        -- the page slug
  utm_campaign       text NOT NULL DEFAULT '' CHECK (length(utm_campaign) <= 200),
  page_id            integer,
  consent_text_id    integer NOT NULL,
  consented_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (phone <> '' OR email <> ''),
  FOREIGN KEY (tenant_id, page_id) REFERENCES reels(tenant_id, id) ON DELETE SET NULL (page_id),
  FOREIGN KEY (tenant_id, consent_text_id) REFERENCES lead_consent_texts(tenant_id, id)
);
CREATE INDEX leads_list_idx ON leads (tenant_id, id DESC);
CREATE INDEX leads_page_idx ON leads (tenant_id, page_id);
CREATE INDEX leads_consent_text_idx ON leads (tenant_id, consent_text_id);
CREATE INDEX leads_phone_idx ON leads (tenant_id, phone) WHERE phone <> '';
CREATE INDEX leads_email_idx ON leads (tenant_id, lower(email)) WHERE email <> '';
SELECT fence_tenant_table('leads');

-- Each channel is its own purpose (9.18): consent is given and withdrawn per channel. A withdrawn channel is never used for
-- marketing again, and the next download marks it (K-58).
CREATE TABLE lead_consents (
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      integer NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email', 'call')),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  PRIMARY KEY (tenant_id, lead_id, channel),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('lead_consents');

-- A download of the business's leads as CSV or XLSX (8.15). The file waits in storage under file_key; every download is also
-- written to the audit log. Only this business's leads can be in it.
CREATE TABLE lead_downloads (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  format      text NOT NULL CHECK (format IN ('csv', 'xlsx')),
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'ready', 'failed', 'expired')),
  file_key    text NOT NULL DEFAULT '' CHECK (length(file_key) <= 300),
  row_count   integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX lead_downloads_list_idx ON lead_downloads (tenant_id, id DESC);
CREATE INDEX lead_downloads_created_by_idx ON lead_downloads (tenant_id, created_by);
SELECT fence_tenant_table('lead_downloads');
