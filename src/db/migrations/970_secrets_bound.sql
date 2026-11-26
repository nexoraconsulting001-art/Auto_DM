-- 970, R2-SEC-1: intentionally changes nothing. A first design marked a bound secret in its first part (`v2~<id>.`),
-- which needed the format CHECKs widened; the built design keeps the stored forms `v1.` / `v2.` (the binding id is
-- sealed inside the value, src/platform/secrets.js), so no schema change is needed. Delete this file before the branch
-- is merged; it is left only because the agent that wrote it may not remove files.
SELECT 1;
