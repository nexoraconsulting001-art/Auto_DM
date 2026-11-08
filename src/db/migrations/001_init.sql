-- Bhava starts on a fresh database. Every business-owned row carries tenant_id, and rows that point at
-- each other share it through composite foreign keys, so the database itself refuses links between
-- two businesses. Money is stored as integer paise (₹1 = 100) to avoid rounding errors.

-- ---- Platform ----

CREATE TABLE tenants (
  id                serial PRIMARY KEY,
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'killed')),
  plan              text NOT NULL DEFAULT 'free',
  next_order_number integer NOT NULL DEFAULT 1001,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Custom domains and extra hostnames. Subdomains of PLATFORM_DOMAIN resolve by slug without a row here.
CREATE TABLE tenant_domains (
  domain     text PRIMARY KEY CHECK (domain = lower(domain)),
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Which business an Instagram account belongs to. Tokens are added in Phase 1 (encrypted).
CREATE TABLE ig_accounts (
  ig_user_id text PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username   text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Plans and what each one includes. A row in tenant_features overrides the plan for one business.
CREATE TABLE plans (
  code text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE plan_features (
  plan_code   text NOT NULL REFERENCES plans(code) ON DELETE CASCADE,
  feature     text NOT NULL,
  limit_value integer,
  PRIMARY KEY (plan_code, feature)
);

CREATE TABLE tenant_features (
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature     text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  limit_value integer,
  PRIMARY KEY (tenant_id, feature)
);

INSERT INTO plans (code, name) VALUES
  ('free', 'Free'), ('t1', 'Automation'), ('t2', 'Catalog'), ('t3', 'Store'), ('t4', 'Android app'), ('t5', 'iOS app');

ALTER TABLE tenants ADD CONSTRAINT tenants_plan_fk FOREIGN KEY (plan) REFERENCES plans(code);

-- ---- Business data ----

CREATE TABLE settings (
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key       text NOT NULL,
  value     text NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mime       text NOT NULL,
  data       bytea NOT NULL,
  size       integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_tenant_idx ON media (tenant_id);

CREATE TABLE products (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  slug          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  price_paise   integer NOT NULL CHECK (price_paise >= 0),
  mrp_paise     integer CHECK (mrp_paise IS NULL OR mrp_paise >= 0),
  images        jsonb NOT NULL DEFAULT '[]',
  option_label  text NOT NULL DEFAULT '',
  option_values text[] NOT NULL DEFAULT '{}',
  stock         integer CHECK (stock IS NULL OR stock >= 0),
  active        boolean NOT NULL DEFAULT true,
  featured      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);

-- Instagram media IDs are unique across Instagram, so they stay the key.
CREATE TABLE reels (
  ig_media_id      text PRIMARY KEY,
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug             text NOT NULL,
  headline         text NOT NULL DEFAULT '',
  keywords         text[] NOT NULL DEFAULT '{}',
  dm_message       text NOT NULL DEFAULT '',
  button_text      text NOT NULL DEFAULT 'Shop now',
  public_reply     text NOT NULL DEFAULT '',
  active           boolean NOT NULL DEFAULT true,
  permalink        text NOT NULL DEFAULT '',
  thumbnail_url    text NOT NULL DEFAULT '',
  video_url        text NOT NULL DEFAULT '',
  caption          text NOT NULL DEFAULT '',
  media_checked_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, ig_media_id)
);

CREATE TABLE reel_products (
  tenant_id  integer NOT NULL,
  reel_id    text NOT NULL,
  product_id integer NOT NULL,
  position   integer NOT NULL,
  PRIMARY KEY (reel_id, product_id),
  FOREIGN KEY (tenant_id, reel_id) REFERENCES reels(tenant_id, ig_media_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE categories (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  image_url   text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  position    integer NOT NULL DEFAULT 0,
  visible     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);

CREATE TABLE product_categories (
  tenant_id   integer NOT NULL,
  product_id  integer NOT NULL,
  category_id integer NOT NULL,
  PRIMARY KEY (product_id, category_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX product_categories_cat_idx ON product_categories (category_id);

-- Accounts belong to one business for now. The shared shopper identity across stores (PRD, Phase 4)
-- replaces this with a platform-level identity plus per-business links.
CREATE TABLE users (
  id            serial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  phone         text NOT NULL,
  email         text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  address       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone),
  UNIQUE (tenant_id, id)
);

-- Server-side sessions, so any web server can read them and a session can be revoked.
-- Only a hash of the cookie value is stored.
CREATE TABLE sessions (
  id         text PRIMARY KEY,
  tenant_id  integer NOT NULL,
  user_id    integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_user_idx ON sessions (tenant_id, user_id);

CREATE TABLE orders (
  id             serial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_number   text NOT NULL,
  public_token   text NOT NULL UNIQUE,
  reel_id        text,
  user_id        integer,
  source         text NOT NULL DEFAULT '',
  customer_name  text NOT NULL,
  phone          text NOT NULL,
  email          text NOT NULL DEFAULT '',
  address        text NOT NULL,
  city           text NOT NULL,
  state          text NOT NULL,
  pincode        text NOT NULL,
  subtotal_paise integer NOT NULL,
  shipping_paise integer NOT NULL,
  total_paise    integer NOT NULL,
  status         text NOT NULL DEFAULT 'awaiting_payment',
  notes          text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, reel_id) REFERENCES reels(tenant_id, ig_media_id) ON DELETE SET NULL (reel_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX orders_status_idx ON orders (tenant_id, status);
CREATE INDEX orders_user_idx ON orders (tenant_id, user_id);

CREATE TABLE order_items (
  id           serial PRIMARY KEY,
  tenant_id    integer NOT NULL,
  order_id     integer NOT NULL,
  product_id   integer,
  name         text NOT NULL,
  image        text NOT NULL DEFAULT '',
  price_paise  integer NOT NULL,
  option_value text NOT NULL DEFAULT '',
  qty          integer NOT NULL CHECK (qty > 0),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE SET NULL (product_id)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- One row per Instagram comment the webhook processed. Comment IDs are unique across Instagram.
CREATE TABLE activity (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  comment_id text UNIQUE,
  reel_id    text,
  user_id    text NOT NULL DEFAULT '',
  username   text NOT NULL DEFAULT '',
  text       text NOT NULL DEFAULT '',
  result     text NOT NULL,
  error      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_reel_idx ON activity (tenant_id, reel_id);

CREATE TABLE visits (
  id         serial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reel_id    text NOT NULL,
  source     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visits_reel_idx ON visits (tenant_id, reel_id);

-- ---- Insert-only logs (PRD 4.16, 5.14) ----

-- Human and admin actions. tenant_id is null for platform-level actions. No foreign key: the audit
-- trail outlives a deleted business.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  integer,
  actor      text NOT NULL,
  action     text NOT NULL,
  target     text NOT NULL DEFAULT '',
  details    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at);

-- Every decision the system makes about sending to Instagram, Facebook or WhatsApp.
CREATE TABLE compliance_events (
  id         bigserial PRIMARY KEY,
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  subject    text NOT NULL DEFAULT '',
  decision   text NOT NULL,
  reason     text NOT NULL DEFAULT '',
  details    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_events_tenant_idx ON compliance_events (tenant_id, created_at);

-- Rows can never be changed. A direct delete works only once a row is older than 13 months (the
-- retention job); deleting a whole business removes its compliance_events through the cascade.
CREATE FUNCTION refuse_log_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME;
  END IF;
  IF pg_trigger_depth() = 1 AND OLD.created_at > now() - interval '395 days' THEN
    RAISE EXCEPTION '% rows can only be deleted after the retention period', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER audit_log_insert_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_log_change();
CREATE TRIGGER compliance_events_insert_only BEFORE UPDATE OR DELETE ON compliance_events
  FOR EACH ROW EXECUTE FUNCTION refuse_log_change();
