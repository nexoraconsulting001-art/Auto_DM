-- Phase 0: public-reply variants live on the brand kit (PRD 4.9, 5.3). Empty means the business has none yet.
ALTER TABLE brand_kits ADD COLUMN public_reply_variants text[] NOT NULL DEFAULT '{}';
