-- Phase 4: loyalty points and referrals (PRD 9.21), an add-on behind the `loyalty` feature. Points are whole numbers with
-- no cash value outside checkout and cannot be moved between shoppers or businesses.
CREATE TABLE loyalty_settings (
  tenant_id              integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled                boolean NOT NULL DEFAULT false,
  -- Earn `earn_points` for every `earn_per_paise` paid, on the amount after discount and before shipping (1 per Rs 100 is 1 and 10000).
  earn_points            integer NOT NULL DEFAULT 1 CHECK (earn_points >= 0),
  earn_per_paise         bigint NOT NULL DEFAULT 10000 CHECK (earn_per_paise > 0),
  -- What one point takes off at checkout, and the most points one order may use (S-88).
  point_value_paise      bigint NOT NULL DEFAULT 100 CHECK (point_value_paise > 0),
  max_redeem_points      integer NOT NULL DEFAULT 0 CHECK (max_redeem_points >= 0),
  -- Posted points lapse after this many days; null never.
  expiry_days            integer CHECK (expiry_days IS NULL OR expiry_days BETWEEN 1 AND 3650),
  -- Referrals: what the friend gets on a first order, and what the referrer gets once that order is delivered and its return window closes.
  referral_enabled       boolean NOT NULL DEFAULT false,
  friend_reward_paise    bigint NOT NULL DEFAULT 0 CHECK (friend_reward_paise >= 0),
  referrer_points        integer NOT NULL DEFAULT 0 CHECK (referrer_points >= 0),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('loyalty_settings');

-- A shopper's running balance. `balance` is what can be spent now and can never go below zero: the database refuses, so two
-- checkouts at once cannot spend the same points. `pending` is earned but not yet posted.
CREATE TABLE loyalty_accounts (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id integer NOT NULL,
  balance    integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  pending    integer NOT NULL DEFAULT 0 CHECK (pending >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shopper_id),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('loyalty_accounts');

-- Every movement of points, signed. `entry_key` is unique, so an order event handled twice moves points once.
--   earn (pending, then posted when the return window closes, or void if refunded first), redeem (at checkout),
--   reverse (earned points taken back on a refund or return), restore (spent points returned on a cancelled order),
--   expire, referral, adjust (by the owner).
CREATE TABLE loyalty_ledger (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id   integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('earn', 'redeem', 'reverse', 'restore', 'expire', 'referral', 'adjust')),
  points       integer NOT NULL CHECK (points <> 0),
  status       text NOT NULL DEFAULT 'posted' CHECK (status IN ('pending', 'posted', 'void')),
  order_id     integer,
  -- 'earn:order:41', 'redeem:order:41', 'reverse:refund:7', 'referral:12'.
  entry_key    text NOT NULL CHECK (length(entry_key) BETWEEN 1 AND 120),
  -- When pending points post, and when posted points lapse.
  available_at timestamptz,
  expires_at   timestamptz,
  actor        text NOT NULL DEFAULT 'system' CHECK (length(actor) <= 80),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entry_key),
  CHECK (CASE kind WHEN 'earn' THEN points > 0 WHEN 'redeem' THEN points < 0 WHEN 'reverse' THEN points < 0 WHEN 'restore' THEN points > 0 WHEN 'expire' THEN points < 0 WHEN 'referral' THEN points > 0 ELSE true END),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX loyalty_ledger_shopper_idx ON loyalty_ledger (tenant_id, shopper_id, id DESC);
CREATE INDEX loyalty_ledger_order_idx ON loyalty_ledger (tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX loyalty_ledger_due_idx ON loyalty_ledger (available_at) WHERE status = 'pending';
CREATE INDEX loyalty_ledger_expiry_idx ON loyalty_ledger (expires_at) WHERE status = 'posted' AND expires_at IS NOT NULL;
-- No DELETE: a wrong entry is corrected by another entry.
SELECT fence_tenant_table('loyalty_ledger', 'SELECT, INSERT, UPDATE');

-- Each shopper's referral link.
CREATE TABLE referral_codes (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shopper_id integer NOT NULL,
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9]{6,12}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shopper_id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE
);
SELECT fence_tenant_table('referral_codes');

-- One row per friend who came through a link. A friend is referred once. Self-referral by the same mobile, device or
-- address is blocked (S-90): the row is kept as 'blocked' with the reason, and no reward is given.
CREATE TABLE referrals (
  id                  bigserial PRIMARY KEY,
  tenant_id           integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  referrer_shopper_id integer NOT NULL,
  -- The friend, as a keyed hash of their phone, so a guest counts and the number is not copied.
  friend_key          text NOT NULL CHECK (length(friend_key) = 64),
  friend_shopper_id   integer,
  order_id            integer,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded', 'blocked', 'void')),
  block_reason        text NOT NULL DEFAULT '' CHECK (block_reason IN ('', 'same_phone', 'same_device', 'same_address', 'not_first_order')),
  friend_reward_paise bigint NOT NULL DEFAULT 0 CHECK (friend_reward_paise >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  rewarded_at         timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, friend_key),
  FOREIGN KEY (tenant_id, referrer_shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, friend_shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE SET NULL (friend_shopper_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (tenant_id, referrer_shopper_id);
CREATE INDEX referrals_order_idx ON referrals (tenant_id, order_id) WHERE order_id IS NOT NULL;
SELECT fence_tenant_table('referrals');
