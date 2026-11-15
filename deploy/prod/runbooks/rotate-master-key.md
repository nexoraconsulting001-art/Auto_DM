# Rotating the master key

Stored secrets (tokens, gateway keys, courier and Shopify credentials, push credentials, TOTP secrets, store keys: `SECRET_COLUMNS` in `src/contracts/secrets.js`) are each encrypted with their own data key, which is wrapped by the master key `DATA_KEY`. Rotating the master key re-wraps the data keys only (F-66). Do it yearly, when someone who held the key leaves, or at once if it may have leaked.

## Steps

1. **Make the new key:** `node -p "require('crypto').randomBytes(32).toString('base64')"` on a trusted machine. Never paste it into a ticket or a chat.
2. **Keep the old one readable.** In the secret store set `DATA_KEY_OLD` to the current `DATA_KEY` (if `DATA_KEY_OLD` already holds keys, add it to the comma-separated list), and `DATA_KEY` to the new key. Both in one change.
3. **Roll the pods** so every process holds the new keyring: `kubectl -n bhava rollout restart deploy/bhava-web deploy/bhava-worker` (with the http secret driver, the refresh picks it up within `SECRETS_REFRESH_SECONDS`; restart anyway).
   Check: `/readyz` is `up` everywhere; sellers' connected accounts still work (new values are written under the new key, old ones still read).
4. **Re-wrap.** The secret-rotation module's job (`secrets.rewrap`) moves every column of `SECRET_COLUMNS` to the new key in small batches, under load, and can stop and resume. Start it from the Platform Console (or let the worker pick it up after the restart).
   Check: every row of `secret_rewraps` for the new key id is `done` (the Platform Console's rotation view, or `SELECT "table", "column", status FROM secret_rewraps ORDER BY 1, 2` on the owner login).
5. **Retire the old key** only when step 4 says every column is done: remove it from `DATA_KEY_OLD` and roll the pods again. The go-live checklist asks the same question.
6. **If something cannot be read** after step 5, put the old key back into `DATA_KEY_OLD` and roll the pods: nothing was re-encrypted, so nothing is lost. Then find the row the job skipped.
