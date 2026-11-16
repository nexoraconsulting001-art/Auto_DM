-- Final review (commerce-8, PRD 9.11): an order already pushed to Shopify and then cancelled here is cancelled in Shopify
-- too, with its stock put back there (Shopify's count is the one both sides sell from). cancel_status follows that call:
-- 'none' (nothing to cancel), 'pending' (due at cancel_next_at, retried with backoff), 'done', or 'failed' (the owner is
-- told to cancel it in Shopify by hand).
ALTER TABLE shopify_order_pushes
  ADD COLUMN cancel_status   text NOT NULL DEFAULT 'none' CHECK (cancel_status IN ('none', 'pending', 'done', 'failed')),
  ADD COLUMN cancel_attempts integer NOT NULL DEFAULT 0 CHECK (cancel_attempts >= 0),
  ADD COLUMN cancel_next_at  timestamptz;
CREATE INDEX shopify_order_pushes_cancel_due_idx ON shopify_order_pushes (cancel_next_at) WHERE cancel_status = 'pending';
