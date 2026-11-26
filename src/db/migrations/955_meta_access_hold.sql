-- B-MSG-6: Meta's release gates (PRD 4.15) are read at every send, not only when an automation goes to Test or Live.
-- gate_lost_at is when a business that had passed every gate stopped passing them with an account still connected ("Meta
-- access lost"). ig-connect recordGates() sets it and clears it when the gates pass again; the send gate holds automated sends
-- while it is set (paused.meta_access), releases them when it clears, and drops one held for more than 24 hours
-- (expired.meta_access). A seller who disconnects on purpose has not lost access, so that does not set it.
ALTER TABLE compliance_settings ADD COLUMN gate_lost_at timestamptz;

INSERT INTO compliance_reason_codes (code, family) VALUES ('paused.meta_access', 'pause'), ('expired.meta_access', 'policy');
