-- Phase 0: a business's own payment gateway keys (PRD 5.14). The secret is encrypted by the secrets module.
CREATE TABLE gateway_keys (
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  key_id         text NOT NULL,
  key_secret_enc text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);
SELECT fence_tenant_table('gateway_keys');
