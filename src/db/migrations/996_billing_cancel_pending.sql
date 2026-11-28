-- R6-RECON-4 (M-6): Bhava ends a subscription in its own rows first (move to Free after grace), then asks Razorpay to
-- cancel it. When that call failed it was never tried again, so the Razorpay subscription stayed live; a later re-subscribe
-- made a second one and the first one's charges were ignored. provider_cancel_pending is the Razorpay subscription whose
-- cancel is still owed: set with the row's own cancellation, cleared once Razorpay has it ended, retried by the billing
-- reconcile, and no new subscription is made while it is set.
ALTER TABLE subscriptions ADD COLUMN provider_cancel_pending text CHECK (provider_cancel_pending IS NULL OR length(provider_cancel_pending) BETWEEN 1 AND 80);
