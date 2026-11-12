-- Phase 6 (PRD 10.14): store review, rejections, the review tasks our team owns, and the pre-submit gate.
-- Owner: src/modules/app-submissions. A submission's state moves only along app_transitions (602), and the triggers below
-- are the second lock behind appSubmissionsFor(ctx).change(): SQL that goes round the code still cannot skip a state, enter
-- review without a passed pre-submit run, or resubmit past an open review task.

-- The state of one brand on one store.
CREATE TABLE app_submissions (
  id                   bigserial PRIMARY KEY,
  tenant_id            integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform             text NOT NULL CHECK (platform IN ('android', 'ios')),
  state                text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'in_review', 'rejected', 'approved', 'live')),
  build_id             bigint,
  app_version          text NOT NULL DEFAULT '',
  build_number         integer,
  live_version         text NOT NULL DEFAULT '',
  live_build_number    integer,
  live_at              timestamptz,
  store_url            text NOT NULL DEFAULT '' CHECK (store_url = '' OR store_url ~ '^https://'),
  provider_ref         text NOT NULL DEFAULT '' CHECK (length(provider_ref) <= 120),
  provider_state       text NOT NULL DEFAULT '' CHECK (length(provider_state) <= 60),   -- the store's own word, last read
  provider_checked_at  timestamptz,
  changed_by           text NOT NULL DEFAULT 'system' CHECK (length(changed_by) <= 80),  -- 'user:12' | 'platform:3' | 'provider:appstore' | 'provider:play'
  change_reason        text NOT NULL DEFAULT '' CHECK (length(change_reason) <= 500),
  submitted_at         timestamptz,
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, platform),
  FOREIGN KEY (tenant_id, build_id) REFERENCES app_builds(tenant_id, id) ON DELETE SET NULL (build_id)
);
SELECT fence_tenant_table('app_submissions');

-- Written only by the trigger below.
CREATE TABLE app_submission_history (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_id  bigint NOT NULL,
  from_state     text NOT NULL,
  to_state       text NOT NULL,
  actor          text NOT NULL,
  reason         text NOT NULL DEFAULT '',
  at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, submission_id) REFERENCES app_submissions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX app_submission_history_idx ON app_submission_history (tenant_id, submission_id, id);
SELECT fence_tenant_table('app_submission_history', 'SELECT, INSERT');

CREATE TABLE app_rejections (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_id  bigint NOT NULL,
  platform       text NOT NULL CHECK (platform IN ('android', 'ios')),
  guideline      text NOT NULL CHECK (guideline ~ '^[0-9A-Za-z_.:() -]{1,40}$'),        -- '4.2.6', '5.1.1(v)', 'play:target_api'
  guideline_key  text GENERATED ALWAYS AS (regexp_replace(guideline, '\(.*$', '')) STORED, -- '4.3(a)' and '4.3' are one guideline
  message        text NOT NULL DEFAULT '' CHECK (length(message) <= 4000),
  playbook_code  text NOT NULL DEFAULT 'unknown' CHECK (length(playbook_code) <= 40),
  app_version    text NOT NULL DEFAULT '',
  build_number   integer,
  provider_key   text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 120),             -- the store's id for it, or 'manual:<uuid>'
  rejected_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, submission_id, provider_key),                                        -- read twice, stored once
  FOREIGN KEY (tenant_id, submission_id) REFERENCES app_submissions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX app_rejections_guideline_idx ON app_rejections (tenant_id, platform, guideline_key, rejected_at);
SELECT fence_tenant_table('app_rejections', 'SELECT, INSERT');

-- Opened by the database after two rejections on one guideline. A business cannot close its own task: our team does,
-- through db.platform.
CREATE TABLE app_review_tasks (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submission_id  bigint NOT NULL,
  platform       text NOT NULL CHECK (platform IN ('android', 'ios')),
  guideline_key  text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by    text NOT NULL DEFAULT '',
  resolution     text NOT NULL DEFAULT '' CHECK (length(resolution) <= 1000),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, submission_id) REFERENCES app_submissions(tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX app_review_tasks_open ON app_review_tasks (tenant_id, platform, guideline_key) WHERE status = 'open';
SELECT fence_tenant_table('app_review_tasks', 'SELECT, INSERT');

-- One row per pre-submit run of a build: each check of PRESUBMIT_CHECKS for that platform, pass or fail, and its guideline.
CREATE TABLE presubmit_runs (
  id            bigserial PRIMARY KEY,
  tenant_id     integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  build_id      bigint NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('android', 'ios')),
  passed        boolean NOT NULL,
  checks        jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),   -- [{ code, guideline, passed, detail }]
  tool_version  text NOT NULL DEFAULT '',
  ran_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, build_id) REFERENCES app_builds(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX presubmit_runs_build_idx ON presubmit_runs (tenant_id, build_id, id DESC);
SELECT fence_tenant_table('presubmit_runs', 'SELECT, INSERT');

CREATE FUNCTION app_submissions_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g text;
  ok boolean;
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.platform <> OLD.platform THEN
    RAISE EXCEPTION 'A submission never changes its business or its store' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_submissions_transition';
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  SELECT guard INTO g FROM app_transitions WHERE machine = 'app_submission' AND from_status = OLD.state AND to_status = NEW.state;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A submission cannot go from % to %', OLD.state, NEW.state USING ERRCODE = 'check_violation', CONSTRAINT = 'app_submissions_transition';
  END IF;
  IF g IN ('presubmit', 'presubmit_no_task') THEN
    SELECT r.passed INTO ok FROM presubmit_runs r
    WHERE r.tenant_id = NEW.tenant_id AND r.build_id = NEW.build_id AND r.platform = NEW.platform
    ORDER BY r.id DESC LIMIT 1;
    IF ok IS NOT TRUE THEN
      RAISE EXCEPTION 'Review needs a passed pre-submit run of this build' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_submissions_guard';
    END IF;
  END IF;
  IF g = 'presubmit_no_task' AND EXISTS (
    SELECT 1 FROM app_review_tasks t WHERE t.tenant_id = NEW.tenant_id AND t.platform = NEW.platform AND t.status = 'open'
  ) THEN
    RAISE EXCEPTION 'A review task is open for this app: it goes back to review once our team resolves it' USING ERRCODE = 'check_violation', CONSTRAINT = 'app_submissions_guard';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER app_submissions_transition BEFORE UPDATE OF state, tenant_id, platform ON app_submissions FOR EACH ROW EXECUTE FUNCTION app_submissions_transition();

CREATE FUNCTION app_submissions_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> OLD.state THEN
    INSERT INTO app_submission_history (tenant_id, submission_id, from_state, to_state, actor, reason)
    VALUES (NEW.tenant_id, NEW.id, OLD.state, NEW.state, NEW.changed_by, NEW.change_reason);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER app_submissions_history AFTER UPDATE OF state ON app_submissions FOR EACH ROW EXECUTE FUNCTION app_submissions_history();

-- Two rejections on one guideline since the app was last live and since the last resolved task for it open one review task.
CREATE FUNCTION app_rejections_review_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  since timestamptz;
  resolved timestamptz;
  n integer;
BEGIN
  SELECT live_at INTO since FROM app_submissions WHERE tenant_id = NEW.tenant_id AND id = NEW.submission_id;
  SELECT max(resolved_at) INTO resolved FROM app_review_tasks
  WHERE tenant_id = NEW.tenant_id AND platform = NEW.platform AND guideline_key = NEW.guideline_key AND status = 'resolved';
  SELECT count(*) INTO n FROM app_rejections
  WHERE tenant_id = NEW.tenant_id AND platform = NEW.platform AND guideline_key = NEW.guideline_key
    AND rejected_at > COALESCE(since, '-infinity'::timestamptz) AND rejected_at > COALESCE(resolved, '-infinity'::timestamptz);
  IF n >= 2 THEN
    INSERT INTO app_review_tasks (tenant_id, submission_id, platform, guideline_key)
    VALUES (NEW.tenant_id, NEW.submission_id, NEW.platform, NEW.guideline_key)
    ON CONFLICT (tenant_id, platform, guideline_key) WHERE status = 'open' DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER app_rejections_review_task AFTER INSERT ON app_rejections FOR EACH ROW EXECUTE FUNCTION app_rejections_review_task();
