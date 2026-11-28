-- R6-P1 (spec C-49): Meta repeats a data deletion callback it did not see answered, with the same signed_request. The
-- request was found again only while still open, by a read then an insert: two copies at once made two requests (two
-- confirmation codes, two erasures), and a copy arriving after the inline erasure finished made a new one. Each request
-- now keeps the digest of the signed_request it came with, unique, so the same callback always maps to one request.
ALTER TABLE data_deletion_requests ADD COLUMN request_digest text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX data_deletion_digest_idx ON data_deletion_requests (channel, request_digest) WHERE request_digest <> '';
