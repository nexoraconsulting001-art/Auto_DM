-- Staff seats are a paid limit (PRD 5.7, 5.11), held by the database as well as by the router (B-AUTH-1).
--
-- team.invite's route-table limit (staff.seats, counted by the team module's 'team.seats') is read before the handler
-- runs, in a statement of its own; the invitation is written afterwards, in another transaction. Six invitations sent at
-- once all read the same count and all passed, so one seat left made several invitations. Like the automations limit
-- (migration 740), the rule is held here under a per-business advisory lock: inserts of open invitations for one business
-- take turns, and each counts what the ones before it committed. The router's check stays the friendly answer; this
-- refusal (check_violation, 'plan.limit_reached', DETAIL the feature) is what holds when requests race past it, and the
-- router turns it into the same plan.limit_reached answer (src/modules/api-v1/index.js).
--
-- Seats in use are counted exactly as 'team.seats' counts them: managers and staff still in the team, and invitations
-- still open. An invitation this transaction just revoked (a new one to the same contact replaces it) is not counted.
CREATE FUNCTION team_invites_within_plan() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  allowed integer;
  used integer;
BEGIN
  IF NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  allowed := entitlement_limit(NEW.tenant_id, 'staff.seats');
  IF allowed IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(4242103, NEW.tenant_id);
  SELECT (SELECT count(*) FROM users WHERE tenant_id = NEW.tenant_id AND role IN ('manager', 'staff') AND removed_at IS NULL)
       + (SELECT count(*) FROM team_invites WHERE tenant_id = NEW.tenant_id AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
    INTO used;
  IF used >= allowed THEN
    RAISE EXCEPTION 'plan.limit_reached' USING ERRCODE = 'check_violation', DETAIL = 'staff.seats';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_invites_within_plan BEFORE INSERT ON team_invites FOR EACH ROW EXECUTE FUNCTION team_invites_within_plan();
