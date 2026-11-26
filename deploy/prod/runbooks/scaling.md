# Scaling from 50 to 1,000 businesses

One structure for every size: the same image, manifests and settings; only counts and sizes change. Each step below is a variable or a number in the overlay, never per-business code.

## What scales by itself

- **Web** (HorizontalPodAutoscaler `bhava-web`): 2 to 10 pods on CPU (65%) and memory (80%). Sessions live in the database, so any pod serves anyone.
- **Worker** (`bhava-worker`): 1 to 6 pods on the queue: the external metric `queue_jobs{status="queued"}` (jobs ready to run, from the queue's `stats()` in `src/platform/queue.js`), 200 ready jobs per pod. This needs a metrics adapter in the cluster that serves Prometheus series as external metrics, with a rule exposing `queue_jobs` summed by `status`.
- Disruption budgets keep one web pod and all but one worker pod through node drains.

## Stages

| Businesses | Web pods | Worker pods | Postgres | Redis | Analytics |
|---|---|---|---|---|---|
| up to 50 | 2 | 1 | 2 vCPU, 4 GB, 100 connections | 1 GB | 2 vCPU, 8 GB |
| 50 to 250 | 2 to 4 | 1 to 2 | 4 vCPU, 16 GB, 200 connections | 2 GB | 4 vCPU, 16 GB |
| 250 to 1,000 | 4 to 10 | 2 to 6 | 8 vCPU, 32 GB, 400 connections, a read replica for the Platform Console | 4 GB, with a replica | 8 vCPU, 32 GB |

These are starting points to watch against, not promises: measure with `npm run load` (Phase 8) at each stage.

## Steps when a stage is reached

1. **Database connections first.** Each web or worker process holds up to 10 app-login connections and 5 owner-login ones. Pods times 15 must stay under the database's `max_connections` with room for migrations and backups; past 250 businesses put a connection pooler (transaction mode) in front, and keep the owner login direct for migrations.
   Check: the database pool metric stays under 80% at peak.
2. **Raise the autoscalers' ceilings** in `deploy/prod/k8s/base/hpa.yaml` only after step 1 allows the extra connections.
3. **Resize the managed services** to the table's row (a variable of the provider's module); Postgres resizes need a short failover: do it in the quiet hours.
4. **Meta rate limits:** every business has its own limits and the compliance gate paces sends per account, so more businesses add no shared limit; watch `meta_` usage metrics for any account near its ceiling.
5. **Queues:** if `queue_oldest_job_seconds` grows while worker pods are at their ceiling, raise `maxReplicas` of `bhava-worker` and the database connections with it.
6. **Storage and backups:** backup time grows with the database; when the nightly dump passes 30 minutes, move to the provider's point-in-time recovery and keep the nightly dump as the second copy. The CronJob's `/tmp` (8 GiB) must hold one dump.
7. **Analytics:** the summaries are per business and per day; past 1,000 businesses, partition the analytics tables by month (a migration of the analytics module).
8. After each change, check the dashboards for a week before the next stage.
