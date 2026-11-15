-- Final review (D-4): an Instagram connection is finished only by the person who started it, in their own session.
-- The callback no longer saves the account: it keeps what Meta gave back here (encrypted, until the finish step or the
-- state's ten minutes are up) with the hash of a one-time finish token. The finish step needs the signed-in session of
-- the person who started: the console's cookie on the host it started from, or the owner app's own token by the API.
-- `via` says which; `start_host` is the host the console started from.
ALTER TABLE oauth_states ADD COLUMN via text NOT NULL DEFAULT 'cookie' CHECK (via IN ('cookie', 'bearer'));
ALTER TABLE oauth_states ADD COLUMN start_host text NOT NULL DEFAULT '';
ALTER TABLE oauth_states ADD COLUMN finish_hash text;
ALTER TABLE oauth_states ADD COLUMN pending_login_enc text NOT NULL DEFAULT '';
ALTER TABLE oauth_states ADD COLUMN finished_at timestamptz;
CREATE UNIQUE INDEX oauth_states_finish_idx ON oauth_states (finish_hash) WHERE finish_hash IS NOT NULL;
