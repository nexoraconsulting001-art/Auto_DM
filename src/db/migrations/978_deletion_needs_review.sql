-- R6-P1 (review C-3): a Meta data deletion request that matches no connected account was marked 'completed' with
-- nothing erased; for a Facebook user (no Facebook user id is stored) the Page's token, threads and messages remained
-- while Meta's status page said the deletion was done. Such a request is now 'needs_review': ops is alerted and checks
-- it by hand. 'completed' means an erasure ran.
ALTER TABLE data_deletion_requests DROP CONSTRAINT data_deletion_requests_status_check;
ALTER TABLE data_deletion_requests ADD CONSTRAINT data_deletion_requests_status_check CHECK (status IN ('requested', 'needs_review', 'completed'));
UPDATE data_deletion_requests SET status = 'needs_review', completed_at = NULL WHERE status = 'completed' AND tenant_id IS NULL;
