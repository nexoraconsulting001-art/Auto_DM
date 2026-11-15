-- Phase 9 (go-live): a cap on how many businesses sign-up may make in one day (India time). NULL is no cap.
-- Set with the mode in the Platform Console; the signup module refuses a new business once the day's count reaches it.
ALTER TABLE signup_settings ADD COLUMN daily_cap integer CHECK (daily_cap IS NULL OR daily_cap BETWEEN 1 AND 100000);
