-- Phase 3: importing products by link, bulk paste, CSV, a Shopify store's public feed and site adapters, the quality gate's
-- verdict on each one, and the scheduled re-check (PRD 8.3 to 8.8).

-- One import: a pasted link, a bulk paste of up to 25, a CSV file, a Shopify feed, or an adapter's product list.
-- A CSV larger than the inline limit waits in storage under file_key until the worker runs it.
CREATE TABLE import_jobs (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('link', 'bulk', 'csv', 'shopify', 'adapter')),
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  source      text NOT NULL DEFAULT '' CHECK (length(source) <= 500),         -- a host or a file name, never a person's data
  file_key    text NOT NULL DEFAULT '' CHECK (length(file_key) <= 300),
  total       integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  created     integer NOT NULL DEFAULT 0 CHECK (created >= 0),
  updated     integer NOT NULL DEFAULT 0 CHECK (updated >= 0),
  unchanged   integer NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  refused     integer NOT NULL DEFAULT 0 CHECK (refused >= 0),
  failed      integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  archived    integer NOT NULL DEFAULT 0 CHECK (archived >= 0),
  error_code  text NOT NULL DEFAULT '' CHECK (length(error_code) <= 60),
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX import_jobs_list_idx ON import_jobs (tenant_id, id DESC);
CREATE INDEX import_jobs_created_by_idx ON import_jobs (tenant_id, created_by);
CREATE INDEX import_jobs_waiting_idx ON import_jobs (created_at) WHERE status IN ('queued', 'running');
SELECT fence_tenant_table('import_jobs');

-- One link or row of a job, with what was read, the quality gate's verdict (8.7) and what became of it. A refused or failed
-- item never blocks the others (8.6). `draft` is the product as read, before the owner saves it; `line` is the CSV line or
-- the link's place in the paste.
CREATE TABLE import_items (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id      integer NOT NULL,
  line        integer NOT NULL CHECK (line >= 0),
  url         text NOT NULL DEFAULT '' CHECK (length(url) <= 2000),
  sku         text NOT NULL DEFAULT '' CHECK (length(sku) <= 100),
  status      text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'draft', 'created', 'updated', 'unchanged', 'existing', 'refused', 'failed', 'archived')),
  read_from   text NOT NULL DEFAULT ''
    CHECK (read_from IN ('', 'adapter', 'shopify', 'json_ld', 'open_graph', 'title', 'csv', 'feed')),
  gate_passed boolean,                                                       -- NULL: the gate didn't run (manual, failed fetch)
  reason      text NOT NULL DEFAULT '' CHECK (length(reason) <= 60),       -- a code from IMPORT_REASONS in src/contracts/catalog.js
  message     text NOT NULL DEFAULT '' CHECK (length(message) <= 300),
  draft       jsonb,
  product_id  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id, line),
  FOREIGN KEY (tenant_id, job_id) REFERENCES import_jobs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE SET NULL (product_id)
);
CREATE INDEX import_items_product_idx ON import_items (tenant_id, product_id);
SELECT fence_tenant_table('import_items');

-- Site adapters (8.4) are code shared by every business; which business may use which is data, set by our team.
CREATE TABLE site_adapters (
  tenant_id  integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  adapter    text NOT NULL CHECK (adapter ~ '^[a-z0-9-]{1,40}$'),
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, adapter)
);
SELECT fence_tenant_table('site_adapters');

-- One row per re-check of one product (8.8): what the worker saw, for Needs attention and support. Kept 90 days.
CREATE TABLE product_checks (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id   integer NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('ok', 'price_changed', 'sold_out', 'back_in_stock', 'broken', 'retry', 'skipped')),
  http_status  integer,
  price_paise  bigint CHECK (price_paise IS NULL OR price_paise >= 0),
  checked_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX product_checks_product_idx ON product_checks (tenant_id, product_id, checked_at DESC);
CREATE INDEX product_checks_age_idx ON product_checks (checked_at);
SELECT fence_tenant_table('product_checks', 'SELECT, INSERT');

-- Platform only: the next moment safeFetch may call each outside host, so one host gets at most one request a second
-- across every business and every process (8.2, K-26). No business can read or change it.
CREATE TABLE fetch_hosts (
  host    text PRIMARY KEY CHECK (host = lower(host) AND length(host) <= 253),
  next_at timestamptz NOT NULL DEFAULT now()
);
