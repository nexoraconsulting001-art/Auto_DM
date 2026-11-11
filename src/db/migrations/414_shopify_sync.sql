-- Phase 4: Shopify sync (PRD 9.11). Each business connects its own Shopify app. Mode 'source': Shopify is the source and
-- orders placed here are pushed to it. Mode 'two_way': both sides change things, the latest change wins, and each clash is logged.
-- Webhooks land in provider_webhook_events (migration 404), deduped by Shopify's webhook id.
CREATE TABLE shopify_connections (
  tenant_id           integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- <name>.myshopify.com, lower case. It names one business, which is how a webhook finds it.
  shop_domain         text NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$'),
  mode                text NOT NULL DEFAULT 'source' CHECK (mode IN ('source', 'two_way')),
  -- Both encrypted with DATA_KEY.
  access_token_enc    text NOT NULL DEFAULT '',
  webhook_secret_enc  text NOT NULL DEFAULT '',
  scopes              text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect', 'paused')),
  connected_at        timestamptz NOT NULL DEFAULT now(),
  -- The nightly reconcile that catches missed webhooks.
  last_reconciled_at  timestamptz,
  last_error          text NOT NULL DEFAULT '' CHECK (length(last_error) <= 200),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shopify_connections_shop_idx ON shopify_connections (shop_domain);
SELECT fence_tenant_table('shopify_connections');

-- Which row here is which thing in Shopify, and when each side last changed it (for "latest wins").
CREATE TABLE shopify_links (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('product', 'variant', 'inventory_item', 'order')),
  local_id    bigint NOT NULL,
  shopify_id  text NOT NULL CHECK (shopify_id ~ '^[0-9]{1,20}$'),
  remote_updated_at timestamptz,
  local_updated_at  timestamptz,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, local_id),
  UNIQUE (tenant_id, kind, shopify_id)
);
SELECT fence_tenant_table('shopify_links');

-- Orders waiting to be pushed to Shopify, one row per order: the order event creates it, and pushing it twice is the same push.
CREATE TABLE shopify_order_pushes (
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id         integer NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pushed', 'failed', 'skipped')),
  shopify_order_id text CHECK (shopify_order_id IS NULL OR shopify_order_id ~ '^[0-9]{1,20}$'),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text NOT NULL DEFAULT '' CHECK (length(last_error) <= 200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  pushed_at        timestamptz,
  PRIMARY KEY (tenant_id, order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shopify_order_pushes_due_idx ON shopify_order_pushes (next_attempt_at) WHERE status = 'pending';
SELECT fence_tenant_table('shopify_order_pushes');

-- Two-way mode: a field both sides changed, which one won, and both values. Insert-only.
CREATE TABLE shopify_conflicts (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('product', 'variant', 'inventory_item', 'order')),
  local_id     bigint NOT NULL,
  shopify_id   text NOT NULL,
  field        text NOT NULL CHECK (length(field) <= 60),
  local_value  text NOT NULL DEFAULT '' CHECK (length(local_value) <= 500),
  remote_value text NOT NULL DEFAULT '' CHECK (length(remote_value) <= 500),
  winner       text NOT NULL CHECK (winner IN ('local', 'remote')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shopify_conflicts_list_idx ON shopify_conflicts (tenant_id, id DESC);
SELECT fence_tenant_table('shopify_conflicts', 'SELECT, INSERT');
