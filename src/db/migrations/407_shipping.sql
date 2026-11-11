-- Phase 4: shipping (PRD 9.10). Managed mode ships on Bhava's Shiprocket account with one pickup location per seller;
-- a seller may connect its own Shiprocket API user instead. A switch applies to new shipments only.
CREATE TABLE shipping_settings (
  tenant_id          integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mode               text NOT NULL DEFAULT 'managed' CHECK (mode IN ('managed', 'own')),
  -- The seller as shipper: the label shows this name and address (S-77).
  pickup_location    text NOT NULL DEFAULT '' CHECK (length(pickup_location) <= 36),
  pickup_name        text NOT NULL DEFAULT '' CHECK (length(pickup_name) <= 80),
  pickup_phone       text NOT NULL DEFAULT '' CHECK (length(pickup_phone) <= 16),
  pickup_line1       text NOT NULL DEFAULT '' CHECK (length(pickup_line1) <= 200),
  pickup_line2       text NOT NULL DEFAULT '' CHECK (length(pickup_line2) <= 200),
  pickup_city        text NOT NULL DEFAULT '' CHECK (length(pickup_city) <= 60),
  pickup_state_code  text NOT NULL DEFAULT '' CHECK (pickup_state_code = '' OR pickup_state_code ~ '^[0-9]{2}$'),
  pickup_pincode     text NOT NULL DEFAULT '' CHECK (pickup_pincode = '' OR pickup_pincode ~ '^[1-9][0-9]{5}$'),
  -- Registered with the courier account in use; a shipment can't be made before it is.
  pickup_registered  boolean NOT NULL DEFAULT false,
  -- Own mode: the seller's Shiprocket API user. The password is encrypted with DATA_KEY.
  own_email          text NOT NULL DEFAULT '' CHECK (length(own_email) <= 254),
  own_password_enc   text NOT NULL DEFAULT '',
  -- Managed charges are passed on at cost: taken from the payout, or billed monthly.
  charge_billing     text NOT NULL DEFAULT 'payout' CHECK (charge_billing IN ('payout', 'monthly')),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- A managed tracking webhook is routed by AWB first and by pickup location second (9.10).
CREATE UNIQUE INDEX shipping_settings_pickup_idx ON shipping_settings (pickup_location) WHERE pickup_location <> '' AND mode = 'managed';
SELECT fence_tenant_table('shipping_settings');

-- A parcel: forward to the shopper, or reverse for a return (9.17). "Ready to ship" makes the shipment, AWB, label and pickup.
CREATE TABLE shipments (
  id                   bigserial PRIMARY KEY,
  tenant_id            integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id             integer NOT NULL,
  kind                 text NOT NULL DEFAULT 'forward' CHECK (kind IN ('forward', 'reverse')),
  mode                 text NOT NULL CHECK (mode IN ('managed', 'own', 'self')),
  provider             text NOT NULL DEFAULT 'shiprocket' CHECK (provider IN ('shiprocket', 'self')),
  provider_order_id    text CHECK (provider_order_id IS NULL OR length(provider_order_id) <= 60),
  provider_shipment_id text CHECK (provider_shipment_id IS NULL OR length(provider_shipment_id) <= 60),
  awb                  text CHECK (awb IS NULL OR awb ~ '^[A-Za-z0-9-]{4,40}$'),
  courier_name         text NOT NULL DEFAULT '' CHECK (length(courier_name) <= 80),
  status               text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'awb_assigned', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'undelivered', 'delivered', 'rto_initiated', 'rto_delivered', 'cancelled', 'lost')),
  -- The provider's files; never shown to a shopper.
  label_url            text NOT NULL DEFAULT '' CHECK (length(label_url) <= 1000),
  manifest_url         text NOT NULL DEFAULT '' CHECK (length(manifest_url) <= 1000),
  weight_grams         integer NOT NULL CHECK (weight_grams > 0),
  length_cm            integer NOT NULL CHECK (length_cm > 0),
  breadth_cm           integer NOT NULL CHECK (breadth_cm > 0),
  height_cm            integer NOT NULL CHECK (height_cm > 0),
  -- What the courier collects at the door: the order's balance (S-21). Zero for prepaid.
  cod_paise            bigint NOT NULL DEFAULT 0 CHECK (cod_paise >= 0),
  -- What the courier charged, at cost (S-77).
  charge_paise         bigint NOT NULL DEFAULT 0 CHECK (charge_paise >= 0),
  pickup_location      text NOT NULL DEFAULT '' CHECK (length(pickup_location) <= 36),
  -- The last tracking event applied, so an older one arriving late changes nothing.
  last_event_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shipments_order_idx ON shipments (tenant_id, order_id);
-- An AWB names one parcel anywhere, which is how a tracking webhook finds its business (S-79).
CREATE UNIQUE INDEX shipments_awb_idx ON shipments (awb) WHERE awb IS NOT NULL;
-- One live forward shipment per order.
CREATE UNIQUE INDEX shipments_live_forward_idx ON shipments (tenant_id, order_id) WHERE kind = 'forward' AND status NOT IN ('cancelled', 'lost', 'rto_delivered');
SELECT fence_tenant_table('shipments');
CREATE TRIGGER shipments_guard BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION status_machine_guard('shipment');
CREATE TRIGGER shipments_record AFTER INSERT OR UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION status_machine_record('shipment');

-- Tracking events as they arrived (9.10), deduped by shipment, the courier's status and its time (S-35).
CREATE TABLE shipment_events (
  id              bigserial PRIMARY KEY,
  tenant_id       integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shipment_id     bigint NOT NULL,
  -- Ours, from SHIPMENT_STATUSES, or '' for a scan that maps to none.
  status          text NOT NULL DEFAULT '' CHECK (length(status) <= 30),
  provider_status text NOT NULL CHECK (length(provider_status) BETWEEN 1 AND 80),
  location        text NOT NULL DEFAULT '' CHECK (length(location) <= 120),
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  -- False when it was older than what the shipment already showed: kept for the record, changed nothing.
  applied         boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, shipment_id, provider_status, occurred_at),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX shipment_events_shipment_idx ON shipment_events (tenant_id, shipment_id, occurred_at);
SELECT fence_tenant_table('shipment_events', 'SELECT, INSERT');

-- Serviceability answers kept briefly (9.10), per pickup and delivery PIN.
CREATE TABLE serviceability_cache (
  tenant_id        integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pickup_pincode   text NOT NULL CHECK (pickup_pincode ~ '^[1-9][0-9]{5}$'),
  delivery_pincode text NOT NULL CHECK (delivery_pincode ~ '^[1-9][0-9]{5}$'),
  serviceable      boolean NOT NULL,
  cod              boolean NOT NULL,
  checked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pickup_pincode, delivery_pincode)
);
SELECT fence_tenant_table('serviceability_cache');
