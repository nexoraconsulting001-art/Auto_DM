# Kubernetes manifests

Plain manifests with kustomize, for any conformant cluster. Track: deploy-templates. Empty until that track builds it.

To build here:

- `base/`: `kustomization.yaml`; a `Deployment` for web (two replicas or more) and one for the worker; a `Service`; an `Ingress` with the class and hosts left to the overlay; a `PodDisruptionBudget` for web; a `HorizontalPodAutoscaler` for web; a `NetworkPolicy`; a `ServiceAccount` with no token mounted; a `ConfigMap` for the settings that are not secret.
- Every pod: `runAsNonRoot`, `readOnlyRootFilesystem`, an `emptyDir` at `/tmp`, all capabilities dropped, `seccompProfile: RuntimeDefault`, requests and limits, `startupProbe` on `/startupz`, `livenessProbe` on `/healthz`, `readinessProbe` on `/readyz` (the worker on `WORKER_HEALTH_PORT` with `WORKER_HEALTH_HOST=0.0.0.0`), and `terminationGracePeriodSeconds` longer than `SHUTDOWN_SECONDS`.
- Secrets arrive as a mounted volume (one file per setting) read with `SECRETS_DRIVER=file`. The base names the volume; where it comes from (a `Secret`, a CSI secret-store driver, an agent) is the overlay's choice. No manifest holds a secret's value.
- `overlays/production/`: the image tag, the replica counts, the hosts, `DEPLOY_ENV=production`. No region and no provider annotation in the base.
- Migrations run in the web container at start, under an advisory lock, so no separate job is needed; a rolling update keeps at least one ready pod.

Checked by `kustomize build` and `kubeconform -strict` in `npm run prod:validate` (G-08).
