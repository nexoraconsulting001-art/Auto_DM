-- Phase 4: orders as a CSV file for the seller (PRD 9.9), this business's only. The file is in private storage under
-- `storage_key`, opened by the seller through the orders module, never through /media. It holds names, phone numbers and
-- addresses, so it lasts a short while (expires_at) and no log ever names what is in it.
CREATE TABLE order_downloads (
  id          serial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'ready', 'failed', 'expired')),
  -- The filters it was made with: { from, to, fulfilment, payment }.
  filters     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
  row_count   integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  storage_key text NOT NULL DEFAULT '' CHECK (length(storage_key) <= 250),
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX order_downloads_list_idx ON order_downloads (tenant_id, id DESC);
CREATE INDEX order_downloads_creator_idx ON order_downloads (tenant_id, created_by) WHERE created_by IS NOT NULL;
SELECT fence_tenant_table('order_downloads');
