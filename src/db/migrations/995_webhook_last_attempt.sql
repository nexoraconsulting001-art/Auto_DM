-- R6-RECON-2 (M-3): a failed webhook event waits its back-off from its last attempt, not from when it arrived. With the
-- back-off measured from received_at, an event an hour old was tried once a minute and all of its tries were used about
-- 62 minutes after it came in. last_attempt_at is when a drainer last began working the event (webhook-drain.js).
ALTER TABLE provider_webhook_events ADD COLUMN last_attempt_at timestamptz;
UPDATE provider_webhook_events SET last_attempt_at = processed_at WHERE attempts > 0 AND last_attempt_at IS NULL;
