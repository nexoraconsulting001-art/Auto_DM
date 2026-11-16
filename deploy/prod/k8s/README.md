# Kubernetes manifests

Plain manifests with kustomize, for any conformant cluster. Nothing here names a region, a cloud or a host; nothing holds a secret's value.

| Folder | What it holds |
|---|---|
| `base/` | `bhava-web` (2+ replicas, rolling with `maxUnavailable: 0`) and `bhava-worker` Deployments, their Services, an Ingress whose default backend is web (sellers' own domains), PodDisruptionBudgets, autoscalers (web on CPU and memory; worker on the queue: external metric `queue_jobs{status="queued"}`), the `bhava-backup` CronJob, NetworkPolicies, a ServiceAccount with no token, and the `bhava-config` ConfigMap of settings that are not secret. |
| `jobs/migrate/` | The migration Job (`node scripts/move-to-cloud.js schema`), applied on its own before each rollout. |
| `overlays/production/` | The image tags, replica counts, hosts, `DEPLOY_ENV=production`, the object storage addresses: placeholders (`example.com`, `set-me`) to fill, or let Terraform set. |
| `overlays/production-migrate/` | The migration Job with the same namespace and image. |
| `examples/` | EXAMPLES ONLY, in no build: an ExternalSecret and a CSI SecretProviderClass for filling the secrets from an outside secret manager. |

Every pod: `runAsNonRoot` (uid 1000), `readOnlyRootFilesystem`, an `emptyDir` at `/tmp`, every capability dropped, `seccompProfile: RuntimeDefault`, requests and limits. Web and worker: `startupProbe` on `/startupz`, `livenessProbe` on `/healthz`, `readinessProbe` on `/readyz` (the worker on port 3001 with `WORKER_HEALTH_HOST=0.0.0.0`), a `preStop` pause so the pod leaves the endpoints before `SIGTERM`, and `terminationGracePeriodSeconds` (45) longer than the pause plus `SHUTDOWN_SECONDS` (25).

## Secrets

The pods mount the Secret `bhava-secrets` at `/run/secrets` (one file per setting) and read it with `SECRETS_DRIVER=file`. That Secret comes from the cluster's secret store: made by hand (`kubectl -n bhava create secret generic bhava-secrets --from-file=<folder>`), by the External Secrets Operator from an outside manager (`examples/external-secrets`, or Terraform's `secrets` variable), or replaced by a CSI volume (`examples/csi-secret-store`).

## Migrations before a rollout

A Job's pod template cannot change, so the Job is not in the base that every rollout re-applies:

```
kubectl -n bhava delete job bhava-migrate --ignore-not-found
kubectl apply -k deploy/prod/k8s/overlays/production-migrate
kubectl -n bhava wait --for=condition=complete job/bhava-migrate --timeout=15m
kubectl apply -k deploy/prod/k8s/overlays/production
```

The web servers also run any missing migration at start under the same advisory lock and answer `/readyz` `behind` until they have, so new code never takes traffic on an old schema. Terraform runs the Job and waits for it before applying the rest.

## The network policy

Default deny for the namespace; DNS allowed; the ingress controller's namespace (label `bhava.app/ingress=true`) and the monitoring namespace (`bhava.app/monitoring=true`) may reach the web and health ports; only pods labelled `bhava.app/data-client` (web, worker, migration, backup) may reach the database, Redis and the analytics database, each on its own port and address range, plus the public internet on 443 (no private range). The ranges in the base are documentation-range placeholders that the overlay or Terraform replaces. A Postgres pod in the namespace (a test cluster) is reachable only from those pods.

Checked by `kustomize build overlays/production` and `kubeconform -strict` in the prod workflow (G-08), and by `test/p9/prod-deploy/k8s.test.js`.
