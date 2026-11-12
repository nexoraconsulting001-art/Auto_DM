-- Phase 7: plans, prices, add-ons, the launch offer, billing settings, feature flags and sign-up settings (PRD 3, 5.7, 5.12, 5.20).
-- Platform tables: no tenant_id. Prices are rows, never code; every open question of PRD 3 and 5.12 is a row or a column here
-- with the PRD's current value as its default, so answering one is an UPDATE.

-- The ladder as data: the lowest plan that includes a feature is the row with the smallest rank.
ALTER TABLE plans ADD COLUMN rank integer;
UPDATE plans SET rank = CASE code WHEN 'free' THEN 0 WHEN 't1' THEN 1 WHEN 't2' THEN 2 WHEN 't3' THEN 3 WHEN 't4' THEN 4 WHEN 't5' THEN 5 END;
ALTER TABLE plans ALTER COLUMN rank SET NOT NULL;
ALTER TABLE plans ADD CONSTRAINT plans_rank_key UNIQUE (rank);

-- What a plan costs for one cycle, in paise, before tax. A yearly row is 10 months' fee (billing_settings.yearly_months).
CREATE TABLE plan_prices (
  plan_code    text NOT NULL REFERENCES plans(code) ON DELETE CASCADE,
  cycle        text NOT NULL CHECK (cycle IN ('monthly', 'yearly')),
  amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
  PRIMARY KEY (plan_code, cycle)
);
INSERT INTO plan_prices (plan_code, cycle, amount_paise)
  SELECT m.code, c.cycle, m.paise * c.months
  FROM (VALUES ('free', 0::bigint), ('t1', 49900), ('t2', 149900), ('t3', 399900), ('t4', 699800), ('t5', 999700)) AS m(code, paise),
       (VALUES ('monthly', 1), ('yearly', 10)) AS c(cycle, months);

-- Everything sold on top of a plan (PRD 3). kind: 'addon' switches a feature on for one business, 'pack' adds units to a
-- meter, 'service' is work our team does (5.17), 'setup' is done-for-you onboarding (5.6).
CREATE TABLE addons (
  code           text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind           text NOT NULL CHECK (kind IN ('addon', 'pack', 'service', 'setup')),
  price_paise    bigint NOT NULL CHECK (price_paise >= 0),
  cycle          text NOT NULL CHECK (cycle IN ('monthly', 'one_time')),
  -- The entitlement it switches on (a tenant_features row while the item runs). Null for a pack and a setup.
  feature        text CHECK (feature IS NULL OR length(feature) BETWEEN 1 AND 60),
  -- The lowest plan that may buy it, and the plan from which it is included (so it is not sold there). Null: never included.
  min_plan       text NOT NULL REFERENCES plans(code),
  included_from  text REFERENCES plans(code),
  -- A pack: which meter and how many units one pack adds. A service: what one unit of it covers (20 reels, 200 updates).
  meter          text CHECK (meter IS NULL OR meter IN ('dms', 'whatsapp_messages', 'ai_units')),
  units          integer CHECK (units IS NULL OR units > 0),
  -- The usage billed at cost on top of the price (pass_through_charges.kind), when there is one.
  pass_through   text CHECK (pass_through IS NULL OR pass_through IN ('whatsapp', 'ai')),
  -- Whether a business may hold more than one (packs, seats).
  many           boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  position       integer NOT NULL DEFAULT 0,
  CHECK ((kind = 'pack') = (meter IS NOT NULL)),
  CHECK (kind <> 'pack' OR units IS NOT NULL)
);
INSERT INTO addons (code, name, kind, price_paise, cycle, feature, min_plan, included_from, meter, units, pass_through, many, position) VALUES
  ('story_dm_triggers',     'Story and DM triggers',     'addon',     19900, 'monthly',  'triggers.story_dm',          't1',   't3', NULL,  NULL,  NULL,       false, 10),
  ('whatsapp',              'WhatsApp',                  'addon',     99900, 'monthly',  'whatsapp_automation',        't1',   NULL, NULL,  NULL,  'whatsapp', false, 20),
  ('ai_replies',            'AI replies',                'addon',     99900, 'monthly',  'ai_replies',                 't1',   NULL, NULL,  NULL,  'ai',       false, 30),
  ('loyalty',               'Loyalty and referrals',     'addon',     49900, 'monthly',  'loyalty',                    't3',   't4', NULL,  NULL,  NULL,       false, 40),
  ('lead_form',             'Lead form',                 'addon',    750000, 'one_time', 'lead_form',                  't1',   't2', NULL,  NULL,  NULL,       false, 50),
  ('extra_seat',            'Extra team member',         'addon',     19900, 'monthly',  'staff.seats',                't1',   NULL, NULL,  1,     NULL,       true,  60),
  ('dm_pack',               'Extra DMs',                 'pack',      29900, 'monthly',  NULL,                         't1',   NULL, 'dms', 10000, NULL,       true,  70),
  ('reel_management',       'Reel management',           'service',  300000, 'monthly',  'service.reel_management',    't1',   NULL, NULL,  20,    NULL,       false, 100),
  ('reel_management_extra', 'Reel management: 10 more',  'service',  200000, 'monthly',  NULL,                         't1',   NULL, NULL,  10,    NULL,       true,  101),
  ('reel_backlog',          'Reel backlog',              'service', 1500000, 'one_time', 'service.reel_backlog',       't1',   NULL, NULL,  50,    NULL,       false, 110),
  ('merchandising',         'Store merchandising',       'service',  300000, 'monthly',  'service.merchandising',      't2',   NULL, NULL,  NULL,  NULL,       false, 120),
  ('catalog_management',    'Catalog management',        'service',  400000, 'monthly',  'service.catalog_management', 't3',   NULL, NULL,  200,   NULL,       false, 130),
  ('performance_report',    'Performance report',        'service',  100000, 'monthly',  'service.performance_report', 't1',   't2', NULL,  NULL,  NULL,       false, 140),
  ('setup_automation',      'Done for you: Automation',  'setup',    499900, 'one_time', NULL,                         'free', NULL, NULL,  NULL,  NULL,       false, 200),
  ('setup_catalog',         'Done for you: Catalog',     'setup',   1499900, 'one_time', NULL,                         'free', NULL, NULL,  NULL,  NULL,       false, 210),
  ('setup_store',           'Done for you: Store',       'setup',   4999900, 'one_time', NULL,                         'free', NULL, NULL,  NULL,  NULL,       false, 220),
  ('setup_app_android',     'Done for you: Android app', 'setup',   4999900, 'one_time', NULL,                         'free', NULL, NULL,  NULL,  NULL,       false, 230),
  ('setup_app_ios',         'Done for you: iOS app',     'setup',   4999900, 'one_time', NULL,                         'free', NULL, NULL,  NULL,  NULL,       false, 240);

-- The billing provider's own id for one of our prices. Prices are our rows, and the provider wants a plan of its own for each
-- amount, so the id is kept here by what it prices: a changed price gets a new row, and old subscriptions keep their old one.
CREATE TABLE provider_plans (
  provider         text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay')),
  plan_code        text NOT NULL REFERENCES plans(code) ON DELETE CASCADE,
  cycle            text NOT NULL CHECK (cycle IN ('monthly', 'yearly')),
  amount_paise     bigint NOT NULL CHECK (amount_paise > 0),
  provider_plan_id text NOT NULL CHECK (length(provider_plan_id) BETWEEN 1 AND 80),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, plan_code, cycle, amount_paise),
  UNIQUE (provider, provider_plan_id)
);

-- Offers. The launch offer: the first 100 paying accounts get 30% off for life. `claimed` is counted here, under the
-- row's lock (claim_offer in 701), and the check refuses the 101st: no code can hand out one more.
CREATE TABLE offers (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  percent_off  integer NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  max_accounts integer NOT NULL CHECK (max_accounts >= 0),
  claimed      integer NOT NULL DEFAULT 0 CHECK (claimed >= 0),
  for_life     boolean NOT NULL DEFAULT false,
  -- What it takes money off: the plan fee only, or add-ons and packs as well.
  applies_to   text NOT NULL DEFAULT 'plan' CHECK (applies_to IN ('plan', 'plan_and_addons')),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offers_not_over_claimed CHECK (claimed <= max_accounts)
);
INSERT INTO offers (code, name, percent_off, max_accounts, for_life) VALUES ('launch', 'Launch offer', 30, 100, true);

-- One row. Who Bhava is on an invoice, the tax, and the rules still open in PRD 5.12 at their current values.
CREATE TABLE billing_settings (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Bhava's legal entity (the seller on a Bhava invoice). Empty until set in the Platform Console: no invoice is issued
  -- without a legal name, a state and a SAC.
  legal_name            text NOT NULL DEFAULT '' CHECK (length(legal_name) <= 200),
  gstin                 text NOT NULL DEFAULT '' CHECK (gstin = '' OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  state_code            text NOT NULL DEFAULT '' CHECK (state_code = '' OR state_code ~ '^[0-9]{2}$'),
  address               text NOT NULL DEFAULT '' CHECK (length(address) <= 400),
  -- To confirm with the CA (5.12): the service code, and the rate in basis points (18%).
  sac                   text NOT NULL DEFAULT '' CHECK (sac = '' OR sac ~ '^[0-9]{4,8}$'),
  tax_rate_bp           integer NOT NULL DEFAULT 1800 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  invoice_prefix        text NOT NULL DEFAULT 'BH' CHECK (invoice_prefix ~ '^[A-Z0-9]{1,3}$'),
  credit_note_prefix    text NOT NULL DEFAULT 'BCN' CHECK (credit_note_prefix ~ '^[A-Z0-9]{1,3}$'),
  -- The settlement statement is sent by this day of the next month (date to confirm).
  statement_day         integer NOT NULL DEFAULT 5 CHECK (statement_day BETWEEN 1 AND 28),
  -- A failed payment starts this many days of grace; then the business is suspended ('move_to_free' is to confirm).
  grace_days            integer NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 60),
  after_grace           text NOT NULL DEFAULT 'suspend' CHECK (after_grace IN ('suspend', 'move_to_free')),
  -- Proration (to confirm): 'none' bills a full line on the next invoice; 'daily' bills the days left in the cycle.
  proration             text NOT NULL DEFAULT 'none' CHECK (proration IN ('none', 'daily')),
  -- Yearly billing charges this many months for twelve.
  yearly_months         integer NOT NULL DEFAULT 10 CHECK (yearly_months BETWEEN 1 AND 12),
  -- Whether a Free business may buy DM packs (to confirm).
  free_can_buy_packs    boolean NOT NULL DEFAULT false,
  -- Included DMs reset each calendar month, on yearly billing too (to confirm).
  dm_reset              text NOT NULL DEFAULT 'calendar_month' CHECK (dm_reset IN ('calendar_month')),
  -- Percent of included DMs plus packs at which the owner is told, once each.
  dm_alert_percents     integer[] NOT NULL DEFAULT '{80,100}',
  -- What the referrer gets when the referred account starts a paid plan (reward to set).
  referral_reward_paise bigint NOT NULL DEFAULT 0 CHECK (referral_reward_paise >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_settings DEFAULT VALUES;

-- Feature flags (5.7): apart from plans, off by default, staged by business (tenant_flags, in 701) or by percentage.
CREATE TABLE feature_flags (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{1,59}$'),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  enabled     boolean NOT NULL DEFAULT false,
  percent     integer NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Self-serve sign-up (5.20). mode: 'closed' takes nobody, 'invite' needs a code, 'public' is open (after Advanced Access).
CREATE TABLE signup_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode               text NOT NULL DEFAULT 'invite' CHECK (mode IN ('closed', 'invite', 'public')),
  -- One Free plan per Instagram account (to confirm).
  free_per_instagram integer NOT NULL DEFAULT 1 CHECK (free_per_instagram >= 1),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO signup_settings DEFAULT VALUES;

-- A code is stored as its hash only. `uses` cannot pass `max_uses`.
CREATE TABLE signup_invites (
  id         bigserial PRIMARY KEY,
  code_hash  text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  note       text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  max_uses   integer NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses       integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL DEFAULT '' CHECK (length(created_by) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signup_invites_not_over_used CHECK (uses <= max_uses)
);

-- Each step of a sign-up and when it happened (F-121). A run starts when the page opens, before there is a business, so
-- both are written through db.platform: tenant_id is filled once signup.start has made the business. From then on that
-- business may read its own run (the fence below); a run with no business yet is seen by no business.
CREATE TABLE signup_runs (
  id            bigserial PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  person_id     bigint REFERENCES people(id) ON DELETE CASCADE,
  tenant_id     integer REFERENCES tenants(id) ON DELETE CASCADE,
  account_type  text CHECK (account_type IS NULL OR account_type IN ('creator', 'seller')),
  invite_id     bigint REFERENCES signup_invites(id) ON DELETE SET NULL,
  referral_code text NOT NULL DEFAULT '' CHECK (length(referral_code) <= 40),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX signup_runs_tenant_idx ON signup_runs (tenant_id);
SELECT fence_tenant_table('signup_runs', 'SELECT');
CREATE TABLE signup_steps (
  run_id bigint NOT NULL REFERENCES signup_runs(id) ON DELETE CASCADE,
  step   text NOT NULL CHECK (step IN ('opened', 'signed_in', 'account_type', 'instagram_connected', 'automation_drafted', 'automation_live', 'finished')),
  at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step)
);

-- Business code reads the catalog and the rules; only the Platform Console writes them.
GRANT SELECT ON plan_prices, addons, offers, billing_settings, feature_flags TO bhava_app;

-- Billing webhooks land in the Phase 4 table, under their own scope.
ALTER TABLE provider_webhook_events DROP CONSTRAINT provider_webhook_events_scope_check;
ALTER TABLE provider_webhook_events ADD CONSTRAINT provider_webhook_events_scope_check CHECK (scope IN ('managed', 'billing') OR scope ~ '^tenant:[0-9]+$');

-- Which plan has which Phase 7 feature. ai_replies, whatsapp_automation and the managed services are in no plan: an add-on
-- (addons.feature) turns each on for one business through tenant_features. The performance report is included from tier 2.
-- staff.seats is a limit; PRD 3 prices an extra seat and names no included number, so every plan has no limit until one is set.
-- badge.made_with stays on the free plan only (migration 004).
WITH tiers (code, rank) AS (SELECT code, rank FROM plans),
ladder (feature, from_rank) AS (VALUES ('service.performance_report', 2), ('staff.seats', 0))
INSERT INTO plan_features (plan_code, feature)
  SELECT tiers.code, ladder.feature FROM ladder JOIN tiers ON tiers.rank >= ladder.from_rank
  ON CONFLICT DO NOTHING;
DELETE FROM plan_features WHERE feature = 'badge.made_with' AND plan_code <> 'free';
