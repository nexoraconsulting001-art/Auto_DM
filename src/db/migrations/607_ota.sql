-- Phase 6 (PRD 10.10): over-the-air updates of the shopper app's JavaScript. Owner: src/modules/ota. Platform tables, no
-- tenant_id and no grant: one release goes to every brand's channel on its runtime, and only our team publishes.
CREATE TABLE ota_releases (
  id                   bigserial PRIMARY KEY,
  runtime_version      text NOT NULL REFERENCES app_runtimes(runtime_version),
  bundle_fingerprint   text NOT NULL CHECK (length(bundle_fingerprint) BETWEEN 8 AND 80),   -- the native fingerprint it was built against
  bundle_id            text NOT NULL CHECK (length(bundle_id) BETWEEN 1 AND 120),            -- the update group published to every channel
  bundle_hash          text NOT NULL CHECK (length(bundle_hash) = 64),
  message              text NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  rollout              smallint NOT NULL DEFAULT 10 CHECK (rollout IN (10, 50, 100)),
  status               text NOT NULL DEFAULT 'publishing' CHECK (status IN ('publishing', 'live', 'rolling_back', 'rolled_back', 'superseded', 'blocked', 'failed')),
  block_reason         text NOT NULL DEFAULT '' CHECK (block_reason IN ('', 'native_change', 'unknown_runtime')),
  rollback_reason      text NOT NULL DEFAULT '' CHECK (rollback_reason IN ('', 'crash_rate', 'manual')),
  baseline_crash_rate  numeric(6,5) CHECK (baseline_crash_rate IS NULL OR baseline_crash_rate BETWEEN 0 AND 1),
  channels_total       integer NOT NULL DEFAULT 0 CHECK (channels_total >= 0),
  channels_done        integer NOT NULL DEFAULT 0 CHECK (channels_done >= 0),
  published_by         text NOT NULL CHECK (length(published_by) <= 80),                      -- 'platform:3'
  request_key          text NOT NULL UNIQUE CHECK (request_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  advanced_at          timestamptz,
  rolled_back_at       timestamptz,
  UNIQUE (runtime_version, bundle_hash),
  CHECK ((status = 'blocked') = (block_reason <> ''))
);
CREATE UNIQUE INDEX ota_releases_one_active ON ota_releases (runtime_version) WHERE status IN ('publishing', 'live', 'rolling_back');

-- Launches and crashes per release and hour, as the apps report them (one device counts once per hour per release).
CREATE TABLE ota_health (
  release_id  bigint NOT NULL REFERENCES ota_releases(id) ON DELETE CASCADE,
  hour        timestamptz NOT NULL CHECK (hour = date_trunc('hour', hour)),
  launches    integer NOT NULL DEFAULT 0 CHECK (launches >= 0),
  crashes     integer NOT NULL DEFAULT 0 CHECK (crashes >= 0),
  PRIMARY KEY (release_id, hour)
);

-- A release moves only along app_transitions; a blocked one was inserted blocked and never moves. Rollout goes 10, 50, 100
-- and only while live. What was published never changes: only the status, the rollout, the counters, the timestamps, and
-- the reason when it is rolled back.
CREATE FUNCTION ota_releases_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.runtime_version <> OLD.runtime_version OR NEW.bundle_fingerprint <> OLD.bundle_fingerprint OR NEW.bundle_id <> OLD.bundle_id
     OR NEW.bundle_hash <> OLD.bundle_hash OR NEW.message <> OLD.message OR NEW.block_reason <> OLD.block_reason
     OR NEW.baseline_crash_rate IS DISTINCT FROM OLD.baseline_crash_rate OR NEW.published_by <> OLD.published_by
     OR NEW.request_key <> OLD.request_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A published release never changes what it is' USING ERRCODE = 'check_violation', CONSTRAINT = 'ota_releases_fixed';
  END IF;
  IF NEW.rollback_reason <> OLD.rollback_reason AND NOT (OLD.rollback_reason = '' AND NEW.status = 'rolling_back' AND OLD.status = 'live') THEN
    RAISE EXCEPTION 'A roll back says why once, as it starts' USING ERRCODE = 'check_violation', CONSTRAINT = 'ota_releases_fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT EXISTS (
    SELECT 1 FROM app_transitions WHERE machine = 'ota_release' AND from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'A release cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'ota_releases_transition';
  END IF;
  IF NEW.rollout <> OLD.rollout AND NOT (OLD.status = 'live' AND NEW.status = 'live' AND ((OLD.rollout = 10 AND NEW.rollout = 50) OR (OLD.rollout = 50 AND NEW.rollout = 100))) THEN
    RAISE EXCEPTION 'Rollout goes 10, 50, 100, and only while live' USING ERRCODE = 'check_violation', CONSTRAINT = 'ota_releases_rollout';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ota_releases_rules BEFORE UPDATE ON ota_releases FOR EACH ROW EXECUTE FUNCTION ota_releases_rules();
