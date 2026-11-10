-- Phase 0: each Instagram account's own token, encrypted by the secrets module. Empty means not connected.
ALTER TABLE ig_accounts ADD COLUMN access_token_enc text NOT NULL DEFAULT '';
ALTER TABLE ig_accounts ADD COLUMN token_updated_at timestamptz;
