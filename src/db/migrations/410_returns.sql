-- Phase 4: returns (PRD 9.17). Requested, then approved or rejected, then reverse pickup, received, and refunded or exchanged.
CREATE TABLE return_settings (
  tenant_id            integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  -- Days after delivery a return can be asked for (S-57). Loyalty points post when this window closes (9.21).
  window_days          integer NOT NULL DEFAULT 7 CHECK (window_days BETWEEN 0 AND 90),
  -- Categories whose products can be returned; empty means all.
  eligible_category_ids integer[] NOT NULL DEFAULT '{}' CHECK (cardinality(eligible_category_ids) <= 500),
  -- Proof every request needs (S-80).
  proof                text NOT NULL DEFAULT 'either' CHECK (proof IN ('photo', 'video', 'either')),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
SELECT fence_tenant_table('return_settings');

CREATE TABLE returns (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id     integer NOT NULL,
  shopper_id   integer,
  status       text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'pickup_scheduled', 'picked_up', 'received', 'refunded', 'exchanged', 'cancelled')),
  resolution   text NOT NULL DEFAULT 'refund' CHECK (resolution IN ('refund', 'exchange')),
  reason       text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  -- Set when it is received. Only 'good' goes back into stock (S-58).
  condition    text CHECK (condition IN ('good', 'not_restockable')),
  restocked    boolean NOT NULL DEFAULT false,
  decided_by   text NOT NULL DEFAULT '' CHECK (length(decided_by) <= 80),
  decline_note text NOT NULL DEFAULT '' CHECK (length(decline_note) <= 500),
  -- The reverse pickup, on the same courier mode as forward shipping, and the refund that closed it.
  shipment_id  bigint,
  refund_id    bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (NOT restocked OR condition = 'good'),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shopper_id) REFERENCES shoppers(tenant_id, id) ON DELETE SET NULL (shopper_id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id) ON DELETE SET NULL (shipment_id),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id) ON DELETE SET NULL (refund_id)
);
CREATE INDEX returns_order_idx ON returns (tenant_id, order_id);
CREATE INDEX returns_status_idx ON returns (tenant_id, status, id DESC);
SELECT fence_tenant_table('returns');
CREATE TRIGGER returns_guard BEFORE UPDATE ON returns FOR EACH ROW EXECUTE FUNCTION status_machine_guard('return');
CREATE TRIGGER returns_record AFTER INSERT OR UPDATE ON returns FOR EACH ROW EXECUTE FUNCTION status_machine_record('return');

CREATE TABLE return_items (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  return_id     bigint NOT NULL,
  order_item_id integer NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  UNIQUE (tenant_id, return_id, order_item_id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES returns(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX return_items_line_idx ON return_items (tenant_id, order_item_id);
SELECT fence_tenant_table('return_items');

-- Proof of the item's state: at least one photo or short video per request. Kept in the business's private storage (never
-- under /media, which anyone with the link can open), shown only to the owner and staff with order access, and deleted
-- with the shopper's data (9.18).
CREATE TABLE return_proofs (
  id           bigserial PRIMARY KEY,
  tenant_id    integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  return_id    bigint NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('photo', 'video')),
  file_key     text NOT NULL CHECK (length(file_key) BETWEEN 1 AND 300),
  content_type text NOT NULL CHECK (length(content_type) <= 100),
  bytes        bigint NOT NULL CHECK (bytes > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, return_id) REFERENCES returns(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX return_proofs_return_idx ON return_proofs (tenant_id, return_id);
SELECT fence_tenant_table('return_proofs');
