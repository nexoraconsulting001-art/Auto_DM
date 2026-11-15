# Rollout and rollback

A release from a built image to traffic, and back. The database changes first, with the new image, while the old pods keep serving; only then do new pods start, and each takes traffic only when `/readyz` passes.

## A release

1. **Build and push** both targets for both architectures with one version tag (see [first-deploy.md](first-deploy.md)). Note the digests.
2. **Run the migration Job with the new image.** Terraform does this in `terraform apply` (a new image makes a new Job, waited for). By hand: set `newTag` in `deploy/prod/k8s/overlays/production-migrate/kustomization.yaml`, then
   `kubectl -n bhava delete job bhava-migrate --ignore-not-found`
   `kubectl apply -k deploy/prod/k8s/overlays/production-migrate`
   `kubectl -n bhava wait --for=condition=complete job/bhava-migrate --timeout=15m`
   Check: the wait returns `condition met`. If the Job fails, stop: `kubectl -n bhava logs job/bhava-migrate` names the migration; nothing else has changed and the old release is still serving. Fix forward with a new image.
3. **Roll out.** Set the same `newTag` for both images in `overlays/production/kustomization.yaml` and `RELEASE` in `overlays/production/config.yaml`, then `kubectl apply -k deploy/prod/k8s/overlays/production`.
4. **Watch it.** `kubectl -n bhava rollout status deploy/bhava-web --timeout=10m` and the same for `deploy/bhava-worker`.
   Check: both finish; the error rate and webhook intake on the dashboards hold steady; `curl -s https://<platform host>/readyz` answers `up`.
5. **Settings only** (no new image): change `overlays/production/config.yaml`, bump the `bhava.app/config-version` value in the overlay's patch, and apply. Terraform restarts the pods by itself when a setting changes.

## Roll back

The previous release's code works on the new schema, because every migration keeps the running release working ([database-changes.md](database-changes.md)). So a roll back is the image only; the database stays.

1. `kubectl -n bhava rollout undo deploy/bhava-web` and `kubectl -n bhava rollout undo deploy/bhava-worker` (or set the previous `newTag` and apply, or re-apply Terraform with the previous image).
2. `kubectl -n bhava rollout status deploy/bhava-web --timeout=10m`.
   Check: `/readyz` is `up` on every pod. (`behind` means the code knows a migration the database has not run; older code never does, so a roll back cannot cause it.)
3. Never roll the database back by restoring a backup to undo a release: that loses every order since. If a migration itself was wrong, write a new one that repairs it and roll forward.

## Compose

1. `docker compose --env-file .env -f compose.yaml run --rm web-1 node scripts/move-to-cloud.js schema` with the new images set in `.env`.
2. `docker compose --env-file .env -f compose.yaml up -d --no-deps web-1`, wait for `healthy`, then `web-2`, then `worker`. The load balancer sends nothing to a server whose `/readyz` fails.
3. To roll back, put the previous image tags back in `.env` and repeat step 2.
