-- Phase 7: what a change of plan does to what a business already has, and the automation limit held by the database
-- (PRD 5.7, 5.20; F-33 to F-35, F-123, F-124, F-128). Track signup-plans, the entitlements folder.
--
-- Inserting a plan_changes row is the change (701). The trigger below runs in that same transaction, whoever wrote the
-- row (billing, the Platform Console, a direct UPDATE of tenants), so no caller can forget it:
--   - a downgrade keeps every row and pauses the live and test automations above the new limit, newest first;
--   - an upgrade (or any change with room) resumes, oldest first, what a plan change paused, never anything else;
--   - checkout, one tap, the badge and the rest follow tenants.plan on the next request (repos.entitlements reads it);
--   - every change but a direct one (whose plan_changes row is its record) adds an audit row and tells the owner.

-- The limit of a feature for one business, as repos.entitlements.limit() answers it: NULL for no limit, 0 when not
-- included or switched off. A business's own tenant_features row replaces the plan's.
CREATE FUNCTION entitlement_limit(p_tenant integer, p_feature text) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  own record;
  included record;
BEGIN
  SELECT enabled, limit_value INTO own FROM tenant_features WHERE tenant_id = p_tenant AND feature = p_feature;
  IF FOUND THEN
    IF NOT own.enabled THEN
      RETURN 0;
    END IF;
    RETURN own.limit_value;
  END IF;
  SELECT f.limit_value INTO included FROM tenants t JOIN plan_features f ON f.plan_code = t.plan AND f.feature = p_feature WHERE t.id = p_tenant;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  RETURN included.limit_value;
END $$;
-- It reads any business's rows, so only the owner's triggers call it.
REVOKE EXECUTE ON FUNCTION entitlement_limit(integer, text) FROM PUBLIC;

-- The plan's number of automations running at once (live or test), held when one is switched on. The automations
-- module counts under the same advisory lock when it creates one (CREATE_LOCK in src/modules/automations/repo.js), so a
-- create and a switch-on, or two switch-ons, cannot both take the last place. The friendly refusal is the entitlements
-- module's beforeAutomationLaunch; this is what holds when two requests race past it.
CREATE FUNCTION automations_within_plan() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  allowed integer;
  running integer;
BEGIN
  allowed := entitlement_limit(NEW.tenant_id, 'automations');
  IF allowed IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(4242102, NEW.tenant_id);
  SELECT count(*) INTO running FROM automations WHERE tenant_id = NEW.tenant_id AND id <> NEW.id AND state IN ('live', 'test');
  IF running >= allowed THEN
    RAISE EXCEPTION 'plan.limit_reached' USING ERRCODE = 'check_violation', DETAIL = 'automations';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automations_within_plan BEFORE UPDATE OF state ON automations FOR EACH ROW
  WHEN (NEW.state IN ('live', 'test') AND OLD.state NOT IN ('live', 'test'))
  EXECUTE FUNCTION automations_within_plan();

CREATE FUNCTION plan_change_effects() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  allowed integer;
  running integer;
  paused integer := 0;
  resumed integer := 0;
  candidate record;
  plan_name text;
  went_up boolean;
  message text;
BEGIN
  -- Rows first, then the lock, in the order automations.setState takes them, so the two cannot deadlock.
  PERFORM 1 FROM automations WHERE tenant_id = NEW.tenant_id AND state IN ('live', 'test', 'paused') ORDER BY id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(4242102, NEW.tenant_id);
  allowed := entitlement_limit(NEW.tenant_id, 'automations');

  IF allowed IS NOT NULL THEN
    UPDATE automations a
       SET state = 'paused', paused_reason = CASE WHEN a.state = 'test' THEN 'plan.limit.test' ELSE 'plan.limit' END, updated_at = now()
      FROM (SELECT id FROM automations WHERE tenant_id = NEW.tenant_id AND state IN ('live', 'test') ORDER BY id OFFSET allowed) above
     WHERE a.tenant_id = NEW.tenant_id AND a.id = above.id;
    GET DIAGNOSTICS paused = ROW_COUNT;
  END IF;

  SELECT count(*) INTO running FROM automations WHERE tenant_id = NEW.tenant_id AND state IN ('live', 'test');
  FOR candidate IN
    SELECT id, paused_reason FROM automations
     WHERE tenant_id = NEW.tenant_id AND state = 'paused' AND paused_reason IN ('plan.limit', 'plan.limit.test')
       AND (ends_at IS NULL OR ends_at > now()) AND link_status <> 'failed'
     ORDER BY id
  LOOP
    EXIT WHEN allowed IS NOT NULL AND running >= allowed;
    UPDATE automations SET state = CASE WHEN candidate.paused_reason = 'plan.limit.test' THEN 'test' ELSE 'live' END, paused_reason = '', updated_at = now()
     WHERE tenant_id = NEW.tenant_id AND id = candidate.id;
    running := running + 1;
    resumed := resumed + 1;
  END LOOP;

  IF NEW.source <> 'direct' THEN
    SELECT name INTO plan_name FROM plans WHERE code = NEW.to_plan;
    SELECT (SELECT rank FROM plans WHERE code = NEW.to_plan) > (SELECT rank FROM plans WHERE code = NEW.from_plan) INTO went_up;
    IF NEW.to_plan = NEW.from_plan THEN
      message := format('Your plan now renews %s.', NEW.to_cycle);
    ELSIF went_up THEN
      message := format('You are now on the %s plan. Everything it includes is ready to use.', plan_name);
    ELSE
      message := format('You are now on the %s plan. All your data is kept; what the plan doesn’t include is switched off.', plan_name);
    END IF;
    IF paused > 0 THEN
      message := message || format(' %s automation(s) above its limit were paused, newest first.', paused);
    END IF;
    IF resumed > 0 THEN
      message := message || format(' %s automation(s) paused for the plan limit are running again.', resumed);
    END IF;
    INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (
      NEW.tenant_id, NEW.actor, 'plan.changed', 'plan_change:' || NEW.id,
      jsonb_build_object('from', NEW.from_plan, 'to', NEW.to_plan, 'fromCycle', NEW.from_cycle, 'toCycle', NEW.to_cycle, 'source', NEW.source, 'paused', paused, 'resumed', resumed)
    );
    INSERT INTO alerts (tenant_id, audience, kind, severity, message, target, dedupe_key)
      VALUES (NEW.tenant_id, 'owner', 'plan.changed', 'info', message, 'plan_change:' || NEW.id, 'plan_change:' || NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER plan_change_effects AFTER INSERT ON plan_changes FOR EACH ROW EXECUTE FUNCTION plan_change_effects();
