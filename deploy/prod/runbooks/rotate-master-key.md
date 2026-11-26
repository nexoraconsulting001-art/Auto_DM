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

## Binding stored secrets to their records (R2-SEC-1, once)

Every stored secret is sealed to its record (table, column, business, row key), so a value copied into another business's row, another row or another column does not open there. Values stored before this change carry no binding: they keep reading until binding is required.

1. **Deploy** the release. Nothing changes for sellers.
2. **Re-wrap** as in step 4 above (no new key is needed): the job binds every value to the row it is in.
   Check: every row of `secret_rewraps` for the current key id is `done`. A `failed` column holds a value sealed to another record (one that was copied in): find it and put the right value back by reconnecting that account; never copy a value between rows.
3. **Require binding:** set `SECRETS_REQUIRE_BINDING=true` and roll the pods. From then on a value with no binding is refused (the go-live item `hosting.secrets` asks for this).
