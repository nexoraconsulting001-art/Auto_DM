-- Phase 4: messages to shoppers (PRD 9.15, 9.16): order alerts and abandoned-cart reminders, by WhatsApp and email only.
-- There is no SMS and nothing here ever goes by Instagram DM. Every send goes through the shopper-message gate
-- (src/contracts/shopper-messages.js), which asks consent first. No table here holds a phone number or an email address:
-- the recipient is read from the order or shopper when the message is sent.

-- The business's own WhatsApp Business account (Cloud API). The token is encrypted with DATA_KEY.
CREATE TABLE whatsapp_accounts (
  tenant_id        integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  waba_id          text NOT NULL CHECK (length(waba_id) BETWEEN 1 AND 40),
  phone_number_id  text NOT NULL CHECK (length(phone_number_id) BETWEEN 1 AND 40),
  display_number   text NOT NULL DEFAULT '' CHECK (length(display_number) <= 20),
  access_token_enc text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect', 'disabled')),
  connected_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Delivery reports arrive by phone number id, which names one business.
CREATE UNIQUE INDEX whatsapp_accounts_phone_idx ON whatsapp_accounts (phone_number_id);
SELECT fence_tenant_table('whatsapp_accounts');

-- The business's message templates and where Meta's review of each stands. Outside the 24 hour window only an approved one can be sent.
CREATE TABLE whatsapp_templates (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- What it is for: an order event, a login code, a cart reminder or a review request.
  purpose       text NOT NULL CHECK (purpose IN ('order_placed', 'order_paid', 'order_shipped', 'order_delivered', 'order_cancelled', 'order_refunded', 'otp', 'cart_reminder', 'review_request', 'return_update')),
  category      text NOT NULL CHECK (category IN ('utility', 'authentication', 'marketing')),
  name          text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND length(name) <= 512),
  language      text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paused')),
  provider_id   text CHECK (provider_id IS NULL OR length(provider_id) <= 60),
  body          text NOT NULL DEFAULT '' CHECK (length(body) <= 1024),
  checked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purpose, language)
);
SELECT fence_tenant_table('whatsapp_templates');

-- Which alerts go out, where email comes from, and the expected WhatsApp cost shown to the owner at cost (9.16).
CREATE TABLE alert_settings (
  tenant_id         integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp          boolean NOT NULL DEFAULT true,
  email             boolean NOT NULL DEFAULT true,
  -- The order events that send a message; all six by default.
  events            text[] NOT NULL DEFAULT ARRAY['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']
    CHECK (events <@ ARRAY['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']::text[]),
  -- 'own' sends from the business's domain (SPF and DKIM verified, 5.4); 'neutral' from the shared sending domain.
  email_from        text NOT NULL DEFAULT 'neutral' CHECK (email_from IN ('own', 'neutral')),
  email_from_local  text NOT NULL DEFAULT 'orders' CHECK (email_from_local ~ '^[a-z0-9._-]{1,40}$'),
  email_reply_to    text NOT NULL DEFAULT '' CHECK (length(email_reply_to) <= 254),
  -- Abandoned-cart reminders (9.15): off until the owner turns them on.
  cart_reminders    boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('alert_settings');

-- One row per order event and channel: the unique key is what makes "sent once per channel" true however many times the
-- event arrives (S-54). A failed send retries, then shows in the admin.
CREATE TABLE order_alerts (
  id                  bigserial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id            integer NOT NULL,
  event               text NOT NULL CHECK (event IN ('placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded', 'review_request', 'return_update')),
  channel             text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  -- Why nothing was sent: 'no_consent', 'template_pending' (S-53), 'no_channel', 'no_address', 'off'.
  skip_reason         text NOT NULL DEFAULT '' CHECK (length(skip_reason) <= 40),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     timestamptz,
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 120),
  -- What WhatsApp charged for it, at cost; null until known.
  cost_paise          bigint CHECK (cost_paise IS NULL OR cost_paise >= 0),
  error_code          text NOT NULL DEFAULT '' CHECK (length(error_code) <= 80),
  -- The order event that caused it, for tracing a duplicate.
  source_event_id     bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  UNIQUE (tenant_id, order_id, event, channel),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX order_alerts_due_idx ON order_alerts (next_attempt_at) WHERE status = 'queued';
CREATE INDEX order_alerts_failed_idx ON order_alerts (tenant_id, id DESC) WHERE status = 'failed';
CREATE UNIQUE INDEX order_alerts_provider_idx ON order_alerts (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
SELECT fence_tenant_table('order_alerts');

-- Abandoned-cart reminders (9.15): at most two per time a cart is left, about 1 hour and 24 hours after the last activity,
-- never between 9 pm and 9 am shopper time, only on a channel the shopper said yes to for marketing.
CREATE TABLE cart_reminders (
  id                  bigserial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cart_id             integer NOT NULL,
  shopper_id          integer NOT NULL,
  episode             integer NOT NULL CHECK (episode >= 1),
  step                integer NOT NULL CHECK (step IN (1, 2)),
  channel             text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  status              text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'skipped', 'failed', 'cancelled')),
  -- Why it stopped: 'ordered', 'emptied', 'opted_out', 'no_consent', 'template_pending'.
  stop_reason         text NOT NULL DEFAULT '' CHECK (length(stop_reason) <= 40),
  scheduled_for       timestamptz NOT NULL,
  sent_at             timestamptz,
  -- The link restores the cart. Only the token's hash is kept.
  restore_token_hash  text CHECK (restore_token_hash IS NULL OR length(restore_token_hash) = 64),
  clicked_at          timestamptz,
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 120),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cart_id, episode, step),
  FOREIGN KEY (tenant_id, cart_id) REFERENCES carts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX cart_reminders_due_idx ON cart_reminders (scheduled_for) WHERE status = 'scheduled';
CREATE UNIQUE INDEX cart_reminders_token_idx ON cart_reminders (restore_token_hash) WHERE restore_token_hash IS NOT NULL;
SELECT fence_tenant_table('cart_reminders');
