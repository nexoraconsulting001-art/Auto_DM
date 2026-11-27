-- Meta's 90 days of account insights are read by their own job, account_backfill (R6-P2-E1, user decision 2026-11-27): it runs once when a
-- business connects Instagram, in chunks until nothing is missing, and then stops. account_daily reads only its own recent days, so a rerun
-- of it rewrites the same days and adds nothing (N-38).
ALTER TABLE insight_polls DROP CONSTRAINT insight_polls_job_check;
ALTER TABLE insight_polls ADD CONSTRAINT insight_polls_job_check
  CHECK (job IN ('account_daily', 'account_backfill', 'demographics', 'media_list', 'media', 'story_list', 'story'));

-- Accounts enrolled before this read their history inside account_daily; each gets a backfill poll that fills whatever is still missing and
-- stops. Each takes its own place in the hour (jitter_seconds, from the account id) so they don't all start at once.
INSERT INTO insight_polls (tenant_id, account_ref, job, call_class, next_due_at, jitter_seconds)
SELECT x.tenant_id, x.id, 'account_backfill', 'insights',
       CASE WHEN date_trunc('hour', now()) + x.jitter * interval '1 second' >= now() THEN date_trunc('hour', now()) + x.jitter * interval '1 second'
            ELSE date_trunc('hour', now()) + interval '1 hour' + x.jitter * interval '1 second' END,
       x.jitter
FROM (SELECT a.tenant_id, a.id, ((a.id::bigint * 2654435761) % 3600)::integer AS jitter FROM analytics_accounts a WHERE a.channel = 'instagram') x
ON CONFLICT (tenant_id, account_ref, job) WHERE media_ref IS NULL DO NOTHING;
