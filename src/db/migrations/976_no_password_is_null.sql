-- D1 (user decision 2026-11-26, F-122): an account with no password stores NULL in users.password_hash, not the '!'
-- placeholder Phase 5 used while the column was NOT NULL. NULL means "no password": checkPassword never matches it, so
-- such an account can never sign in by password (sign-in, password change, linking other businesses all go through it).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
UPDATE users SET password_hash = NULL WHERE password_hash = '!';
