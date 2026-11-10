-- Phase 0: sessions for the API and mobile app. A cookie token can never be used as a bearer token, or the reverse.
ALTER TABLE sessions ADD COLUMN kind text NOT NULL DEFAULT 'cookie' CHECK (kind IN ('cookie', 'bearer'));
