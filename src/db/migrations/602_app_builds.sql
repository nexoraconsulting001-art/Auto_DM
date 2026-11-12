-- Phase 6 (PRD 10.8): per-brand builds. Owner: src/modules/app-builds.

-- Every allowed move of the three Phase 6 machines, the same rows as APP_TRANSITIONS in src/contracts/apps.js (a test keeps
-- them equal). Shared reference data, read by the triggers below and in 603 and 607.
CREATE TABLE app_transitions (
  machine      text NOT NULL CHECK (machine IN ('app_build', 'app_submission', 'ota_release')),
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  guard        text NOT NULL DEFAULT '' CHECK (guard IN ('', 'presubmit', 'presubmit_no_task')),
  PRIMARY KEY (machine, from_status, to_status)
);
INSERT INTO app_transitions (machine, from_status, to_status, guard) VALUES
  ('app_build', 'queued', 'building', ''),
  ('app_build', 'queued', 'failed', ''),
  ('app_build', 'building', 'built', ''),
  ('app_build', 'building', 'failed', ''),
  ('app_build', 'built', 'submitted', ''),
  ('app_submission', 'draft', 'in_review', 'presubmit'),
  ('app_submission', 'in_review', 'rejected', ''),
  ('app_submission', 'in_review', 'approved', ''),
  ('app_submission', 'rejected', 'in_review', 'presubmit_no_task'),
  ('app_submission', 'approved', 'live', ''),
  ('app_submission', 'approved', 'in_review', 'presubmit'),
  ('app_submission', 'live', 'in_review', 'presubmit'),
  ('ota_release', 'publishing', 'live', ''),
  ('ota_release', 'publishing', 'failed', ''),
  ('ota_release', 'live', 'rolling_back', ''),
  ('ota_release', 'rolling_back', 'rolled_back', ''),
  ('ota_release', 'live', 'superseded', '');
GRANT SELECT ON app_transitions TO bhava_app;

-- One native fingerprint per runtime version: an over-the-air update must be built against it (607). Platform only.
CREATE TABLE app_runtimes (
  runtime_version  text PRIMARY KEY CHECK (length(runtime_version) BETWEEN 1 AND 40),
  fingerprint      text NOT NULL CHECK (length(fingerprint) BETWEEN 8 AND 80),
  app_version      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Why builds were asked for: one brand, or a native change that rebuilds every brand (tenant_id NULL). Platform only:
-- row-level security with the usual policy and no grant, so business code cannot touch it.
CREATE TABLE app_build_batches (
  id               bigserial PRIMARY KEY,
  reason           text NOT NULL CHECK (reason IN ('brand', 'native_change')),
  tenant_id        integer REFERENCES tenants(id) ON DELETE CASCADE,
  app_version      text NOT NULL,
  runtime_version  text NOT NULL REFERENCES app_runtimes(runtime_version),
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  requested_by     text NOT NULL CHECK (length(requested_by) <= 80),        -- 'user:12' | 'platform:3' | 'system'
  request_key      text NOT NULL UNIQUE CHECK (request_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CHECK ((reason = 'brand') = (tenant_id IS NOT NULL))
);
CREATE INDEX app_build_batches_tenant_idx ON app_build_batches (tenant_id, created_at DESC);
ALTER TABLE app_build_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON app_build_batches USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE app_builds (
  id                      bigserial PRIMARY KEY,
  tenant_id               integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id                bigint NOT NULL REFERENCES app_build_batches(id) ON DELETE RESTRICT,
  reason                  text NOT NULL CHECK (reason IN ('brand', 'native_change')),   -- copied from the batch, which a business cannot read
  platform                text NOT NULL CHECK (platform IN ('android', 'ios')),
  app_version             text NOT NULL CHECK (app_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'),
  build_number            integer NOT NULL CHECK (build_number > 0),
  runtime_version         text NOT NULL,
  driver                  text NOT NULL CHECK (driver IN ('local', 'eas')),
  profile                 text NOT NULL DEFAULT 'production' CHECK (profile IN ('production', 'preview', 'simulator')),
  status                  text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'built', 'failed', 'submitted')),
  failed_step             text NOT NULL DEFAULT '' CHECK (failed_step IN ('', 'load', 'validate', 'assets', 'brand_file', 'build')),
  failed_field            text NOT NULL DEFAULT '' CHECK (length(failed_field) <= 80),
  failed_message          text NOT NULL DEFAULT '' CHECK (length(failed_message) <= 500),
  submit_error            text NOT NULL DEFAULT '' CHECK (length(submit_error) <= 500),   -- a failed submit leaves the build 'built'
  provider_build_id       text NOT NULL DEFAULT '' CHECK (length(provider_build_id) <= 80),
  provider_submission_id  text NOT NULL DEFAULT '' CHECK (length(provider_submission_id) <= 80),
  artifact_key            text NOT NULL DEFAULT '' CHECK (length(artifact_key) <= 300),     -- private storage, never /media
  fingerprint             text NOT NULL DEFAULT '' CHECK (length(fingerprint) <= 80),
  config_hash             text NOT NULL DEFAULT '' CHECK (length(config_hash) <= 80),       -- the brand file it was built from
  request_key             text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  requested_by            text NOT NULL CHECK (length(requested_by) <= 80),
  created_at              timestamptz NOT NULL DEFAULT now(),
  started_at              timestamptz,
  finished_at             timestamptz,
  submitted_at            timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, platform, build_number),
  UNIQUE (tenant_id, platform, request_key),                    -- the same request twice is one build
  CHECK ((status = 'failed') = (failed_step <> ''))
);
CREATE UNIQUE INDEX app_builds_one_running ON app_builds (tenant_id, platform) WHERE status IN ('queued', 'building');
CREATE INDEX app_builds_recent_idx ON app_builds (tenant_id, created_at DESC);
CREATE INDEX app_builds_batch_idx ON app_builds (batch_id);
SELECT fence_tenant_table('app_builds');

-- A build moves only along app_transitions, and what identifies it never changes. Fires on every update, so the fixed
-- columns hold even when the status does not move.
CREATE FUNCTION app_builds_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.build_number <> OLD.build_number OR NEW.platform <> OLD.platform OR NEW.app_version <> OLD.app_version
     OR NEW.request_key <> OLD.request_key OR NEW.batch_id <> OLD.batch_id OR NEW.reason <> OLD.reason THEN
    RAISE EXCEPTION 'A build''s number, platform, version and request never change' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_builds_fixed';
  END IF;
  IF NEW.status <> OLD.status AND NOT EXISTS (
    SELECT 1 FROM app_transitions WHERE machine = 'app_build' AND from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'A build cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation', CONSTRAINT = 'app_builds_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_builds_transition BEFORE UPDATE ON app_builds FOR EACH ROW EXECUTE FUNCTION app_builds_transition();

-- The first submitted build of a platform locks the ids the store knows the app by (app_configs_locked, 601).
CREATE FUNCTION app_builds_lock_ids() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
    IF NEW.platform = 'android' THEN
      UPDATE app_configs SET android_locked_at = COALESCE(android_locked_at, now()) WHERE tenant_id = NEW.tenant_id;
    ELSE
      UPDATE app_configs SET ios_locked_at = COALESCE(ios_locked_at, now()) WHERE tenant_id = NEW.tenant_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER app_builds_lock_ids AFTER UPDATE OF status ON app_builds FOR EACH ROW EXECUTE FUNCTION app_builds_lock_ids();
