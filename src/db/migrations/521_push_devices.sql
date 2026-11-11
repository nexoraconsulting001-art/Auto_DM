-- Phase 5 (PRD 10.5): where the owner app of a person can be pushed to. One APNs key and one FCM project serve every
-- business, so a device belongs to a person, not to a business: a platform table, no tenant_id, no grant to bhava_app,
-- reached only through db.platform. Which businesses a push may be about is decided per event, from users.person_id.
--
-- The token is stored encrypted (platform.secrets); token_hash (a keyed hash) is how a token is found and is unique, so
-- a phone handed to someone else moves with its token. A token the provider calls unregistered or invalid is deleted:
-- deleted_at is set and the token itself is wiped, and the row stays only to say why.
CREATE TABLE push_devices (
  id            bigserial PRIMARY KEY,
  person_id     bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- The same id the app gives at sign-in (auth_devices.device_id), so revoking a device can drop its push token too.
  device_id     text NOT NULL CHECK (device_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  platform      text NOT NULL CHECK (platform IN ('android', 'ios')),
  token_enc     text,
  token_hash    text NOT NULL UNIQUE,
  app_version   text NOT NULL DEFAULT '' CHECK (length(app_version) <= 20),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_ok_at    timestamptz,
  deleted_at    timestamptz,
  delete_reason text NOT NULL DEFAULT '' CHECK (delete_reason IN ('', 'unregistered', 'invalid_token', 'signed_out', 'device_revoked', 'account_deleted')),
  UNIQUE (person_id, device_id),
  CHECK ((deleted_at IS NULL) = (token_enc IS NOT NULL)),
  CHECK ((deleted_at IS NULL) = (delete_reason = ''))
);
CREATE INDEX push_devices_person_idx ON push_devices (person_id) WHERE deleted_at IS NULL;
