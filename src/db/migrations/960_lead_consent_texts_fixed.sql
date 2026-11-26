-- A consent wording a lead agreed to is never rewritten (PRD 8.15, K-56): a changed wording is a new version, and a lead keeps the
-- one it agreed to. The table already grants the app only SELECT and INSERT, but a grant is not a record guarantee (an owner role,
-- a repair script and a test database all bypass it), so the row itself refuses any UPDATE. Deleting a business still removes its
-- wordings through the cascade.
CREATE FUNCTION lead_consent_text_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lead_consent_texts rows are never changed; add a new version';
END $$;

CREATE TRIGGER lead_consent_texts_fixed BEFORE UPDATE ON lead_consent_texts
  FOR EACH ROW EXECUTE FUNCTION lead_consent_text_fixed();
