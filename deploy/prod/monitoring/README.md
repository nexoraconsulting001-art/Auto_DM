# Monitoring

Alert rules, routes, dashboards and the outside probe for the platform, for any Prometheus-compatible stack (Prometheus, Alertmanager, Grafana, a blackbox exporter). Track: prod-observability.

## What is here

| Path | What |
| --- | --- |
| `rules/*.yaml` | Prometheus alert rules, one file per area. Every alert has `severity` (`page` or `ticket`) and `area` labels and plain-text annotations with a link to its section below. |
| `rules/tests/*.yaml` | `promtool test rules` files: each alert fires on bad input and is gone after recovery. |
| `alertmanager.yaml` | Routes by severity. Where alerts go is read from files the deploy mounts, so no address or key is in the repository. |
| `probe/blackbox.yaml`, `probe/scrape.yaml` | The outside probe of the webhook address and a shopper page, and the scrape jobs. Addresses are placeholders. |
| `dashboards/*.json` | Grafana dashboards: platform overview, webhooks and queue, sending and compliance, store and payments, database and runtime. |

## Rules of the road

- Every metric a rule or a dashboard names is in the catalogue (`METRICS` in `src/contracts/metrics.js`) or is one the stack itself provides (`EXTERNAL_METRICS`, plus the cluster's `container_memory_working_set_bytes` and `container_spec_memory_limit_bytes` for the memory alert). `test/p9/prod-observability` fails when one is not, or when a label is not one the metric has.
- No metric has a business, a person, an address, a path or text as a label. Per-business numbers (errors, Meta calls and usage, queue depth and age, when the last webhook arrived) are in the Platform Console (Observability), read through `platform.businessOps`, and are fenced like any other business data. A business appears at /metrics only as a member of a bounded class, such as its plan.
- Annotations are plain text: no template reads a label or a value, so no alert can quote a person.
- `/metrics` answers only to `Authorization: Bearer <METRICS_TOKEN>`; the scrape job reads the token from a file.
- The uptime objective is 99.5% over 30 days of the outside probe (`UPTIME_SLO`). Three burn-rate alerts (1 hour and 5 minutes at 14.4 times, 6 hours and 30 minutes at 6 times: pages; 3 days and 6 hours at 1 time: a ticket) read `probe_success`.
- The database connection alert counts the connections the database reports for the process's pools; its 85 assumes the default limit of 100. Set it to 85% of the real `max_connections`.

## Checks

```
promtool check rules deploy/prod/monitoring/rules/*.yaml
promtool test rules deploy/prod/monitoring/rules/tests/*.yaml
amtool check-config deploy/prod/monitoring/alertmanager.yaml
node --test "test/p9/prod-observability/**/*.test.js"
```

The last one also runs the same rule tests in a small PromQL evaluator that needs no promtool, and checks the catalogue, the labels, the dashboards and the routes.

## Alerts


### bhava-webhooks

#### WebhookIntakeFailing

More than 5% of a provider's webhook deliveries were refused by us (a fault, not a bad signature) for 5 minutes. The provider retries for a limited time, so events can be lost.

- Severity: `page`, area `webhooks`, for 5m.
- Expression: `sum by (provider) (rate(webhook_received_total{provider=~"meta|whatsapp|shopify",result="refused"}[5m])) / sum by (provider) (rate(webhook_received_total{provider=~"meta|whatsapp|shopify"}[5m])) > 0.05 and sum by (provider) (rate(webhook_received_total{provider=~"meta|whatsapp|shopify"}[5m])) > 0.01`
- What to do: Open the web logs for the webhook route (the request id is in every line). A 5xx from us is usually the database or the queue; check readiness (`/readyz`) first. Meta retries for a while, so fix it quickly and then check the Platform Console for businesses with a gap.

#### WebhookIntakeSlow

The slowest 5% of requests to the Meta webhook take longer than 2 seconds for 10 minutes. Meta times out slow endpoints and may stop delivering.

- Severity: `page`, area `webhooks`, for 10m.
- Expression: `histogram_quantile(0.95, sum by (le) (rate(http_request_seconds_bucket{group="webhook"}[5m]))) > 2`
- What to do: Look at the database panel (connections, waiting) and at the queue: intake writes the event down before it answers. Scale web or the pool if requests are waiting for a connection.

#### WebhookNotStored

Accepted webhook deliveries outnumber the events stored for 10 minutes. An event answered with a 200 and not stored is lost for good.

- Severity: `page`, area `webhooks`, for 10m.
- Expression: `sum(rate(webhook_received_total{result="accepted"}[10m])) - sum(rate(webhook_stored_total[10m])) > 0.05`
- What to do: Stop and look: deliveries are being acknowledged but not written. Check the error reports of kind `webhook` and the database; do not restart before reading the logs.

#### WebhookProcessingFailing

More than 10% of the stored events of a provider failed when worked through, for 10 minutes. They stay stored and are retried.

- Severity: `ticket`, area `webhooks`, for 10m.
- Expression: `sum by (provider) (rate(webhook_processed_total{result="failed"}[10m])) / sum by (provider) (rate(webhook_processed_total[10m])) > 0.1`
- What to do: Events are stored and will be retried. Find the failing kind in the error reports and fix the cause; the oldest unprocessed event shows how far behind it is.

#### PaymentWebhookFailing

Razorpay webhooks (store payments or Bhava's own billing) were refused or failed in processing for 10 minutes. Orders may stay unpaid and subscriptions may not renew until they are retried.

- Severity: `page`, area `store`, for 10m.
- Expression: `sum(rate(webhook_received_total{provider=~"razorpay|razorpay_billing",result="refused"}[10m])) > 0.01 or sum(rate(webhook_processed_total{provider=~"razorpay|razorpay_billing",result="failed"}[10m])) > 0.01`
- What to do: Check Razorpay's webhook delivery log from the dashboard of the account named by the provider label, then our web logs. Orders and renewals depend on these; Razorpay retries, so replay from its dashboard once fixed.

#### CourierWebhookFailing

Shiprocket tracking webhooks were refused or failed in processing for 15 minutes. Shipment status shown to buyers will lag until they are retried.

- Severity: `ticket`, area `store`, for 15m.
- Expression: `sum(rate(webhook_received_total{provider="shiprocket",result="refused"}[10m])) > 0.01 or sum(rate(webhook_processed_total{provider="shiprocket",result="failed"}[10m])) > 0.01`
- What to do: Check the courier's webhook log and our web logs. Shipment status lags until it is fixed; nothing is lost because the courier can be asked for status.

### bhava-queue

#### QueueGrowing

More than 500 jobs are waiting in a queue and there are more than 15 minutes ago, for 15 minutes. Workers are not keeping up.

- Severity: `ticket`, area `queue`, for 15m.
- Expression: `sum by (queue) (queue_jobs{status="queued"}) > 500 and sum by (queue) (queue_jobs{status="queued"}) > sum by (queue) (queue_jobs{status="queued"} offset 15m)`
- What to do: Is the worker up and keeping up? Check `up` for the worker, its memory, and the slowest queue on the webhooks and queue dashboard. Add workers if the load is real.

#### QueueOldestJobTooOld

The oldest waiting job in a queue is more than 10 minutes old for 5 minutes. Messages and webhooks queued behind it are delayed.

- Severity: `ticket`, area `queue`, for 5m.
- Expression: `max by (queue) (queue_oldest_job_seconds) > 600`
- What to do: A job is stuck behind others or its handler is slow. Check the queue named in the alert, then the worker's error reports.

#### QueueStuck

The oldest waiting job in a queue is more than 30 minutes old for 5 minutes. The worker is probably down or wedged.

- Severity: `page`, area `queue`, for 5m.
- Expression: `max by (queue) (queue_oldest_job_seconds) > 1800`
- What to do: The queue is not moving. Check the worker is running and not draining, and restart it if it is wedged. Jobs that were running when a worker died are marked unknown and are never run twice.

#### QueueJobsFailing

More than 20% of the runs of a queue failed for 10 minutes.

- Severity: `ticket`, area `queue`, for 10m.
- Expression: `sum by (queue) (rate(job_runs_total{result="failed"}[10m])) / sum by (queue) (rate(job_runs_total[10m])) > 0.2`
- What to do: Read the error reports for the kind named after the queue. Failing jobs are retried up to their limit and then stay failed for a person to look at.

### bhava-sending

#### SendsFailing

More than 10% of send attempts on a channel failed for 10 minutes. Buyers are not getting their replies.

- Severity: `page`, area `sending`, for 10m.
- Expression: `sum by (channel) (rate(compliance_outcomes_total{outcome="failed"}[10m])) / sum by (channel) (rate(compliance_outcomes_total{outcome=~"sent|failed"}[10m])) > 0.1 and sum by (channel) (rate(compliance_outcomes_total{outcome=~"sent|failed"}[10m])) > 0.01`
- What to do: Check Meta's status and the throttling and token panels. If the failures are one class of call, the reason family panel names it. Sends that failed with an unknown outcome are never resent.

#### SendsHeld

The compliance gate has held messages on a channel (for review or for a plan's message limit) at more than three a minute for 15 minutes.

- Severity: `ticket`, area `sending`, for 15m.
- Expression: `sum by (channel) (rate(compliance_outcomes_total{family="held"}[15m])) > 0.05`
- What to do: Held sends wait for a review or a business's message limit. If one business is the cause, the Platform Console shows it; if it is everyone, check the plan limits settings.

#### ComplianceGateEngaged

More than half of the send decisions on a channel were refused as paused for 10 minutes: the global kill switch or the circuit breaker is engaged, or every business paused at once. Check the compliance screen before anything else.

- Severity: `page`, area `sending`, for 10m.
- Expression: `sum by (channel) (rate(compliance_outcomes_total{family="paused"}[10m])) / sum by (channel) (rate(compliance_outcomes_total[10m])) > 0.5 and sum by (channel) (rate(compliance_outcomes_total[10m])) > 0.02`
- What to do: Open the compliance screen: the global kill switch, the circuit breaker, or a mass pause is on. Do not release anything until you know why it was engaged.

#### MetaThrottling

Meta answered calls of a class with a rate-limit error at more than one a minute for 10 minutes.

- Severity: `ticket`, area `sending`, for 10m.
- Expression: `sum by (call_class) (rate(meta_calls_total{result="throttled"}[10m])) > 0.02`
- What to do: Meta is limiting us. Lower the poll rates (insights first), and check which class is hit. Sends back off by themselves.

#### MetaUsageHigh

Some account has used more than 80% of a Meta rate limit for 10 minutes. Throttling is likely next.

- Severity: `ticket`, area `sending`, for 10m.
- Expression: `max by (call_class) (meta_usage_ratio) > 0.8`
- What to do: An account is using most of a Meta limit. Look at the businesses with the most calls in the Platform Console before it becomes a throttle.

#### MetaUsageCritical

Some account has used more than 95% of a Meta rate limit for 5 minutes. Sends of that class are about to be refused.

- Severity: `page`, area `sending`, for 5m.
- Expression: `max by (call_class) (meta_usage_ratio) > 0.95`
- What to do: Throttling is imminent. Pause the heaviest background reads for the class named in the alert.

#### MetaTokenFailuresRising

Calls to Meta failed for an invalid or revoked token at more than one every two minutes for 10 minutes. Businesses may need to reconnect, or a refresh is failing.

- Severity: `ticket`, area `sending`, for 10m.
- Expression: `sum(rate(meta_calls_total{result="token_error"}[15m])) > 0.01`
- What to do: Tokens are being rejected: a business revoked access, or our refresh is failing. Check the secret refresh and token panels; affected businesses are told to reconnect.

### bhava-store

#### BillingChargesFailing

At least two of Bhava's own Razorpay calls failed in the last hour and they are more than 30% of all such calls. Renewals may not be collected.

- Severity: `page`, area `store`, for 5m.
- Expression: `sum(increase(provider_calls_total{provider="razorpay_billing",result!="ok"}[1h])) / sum(increase(provider_calls_total{provider="razorpay_billing"}[1h])) > 0.3 and sum(increase(provider_calls_total{provider="razorpay_billing",result!="ok"}[1h])) >= 2`
- What to do: Check Razorpay's billing account for the reason (a failed mandate, an expired key). Subscriptions go to their grace period, not straight to suspended.

#### StoreErrorRate

More than 5% of the requests of a route class were answered with a 5xx for 5 minutes.

- Severity: `page`, area `store`, for 5m.
- Expression: `sum by (group) (rate(http_requests_total{status=~"5.."}[5m])) / sum by (group) (rate(http_requests_total[5m])) > 0.05 and sum by (group) (rate(http_requests_total[5m])) > 0.1`
- What to do: The route class named in the alert answers 5xx. Look at the error reports and at readiness; roll back the last deploy if it started with one.

### bhava-platform

#### BackupTooOld

No backup has finished for more than 26 hours (the nightly one is due every 24).

- Severity: `page`, area `database`, for 10m.
- Expression: `backup_age_seconds > 93600`
- What to do: The nightly backup did not finish. Run it by hand from the worker (`npm run backup`) after finding why; a backup that cannot be restored is not a backup, so run the restore drill soon after.

#### BackupNotReporting

The worker has reported no backup at all for 26 hours: backups may be switched off (BACKUP_STORAGE_DRIVER) or the worker is not running.

- Severity: `ticket`, area `database`, for 26h.
- Expression: `absent(backup_age_seconds)`
- What to do: Nothing has reported a backup in 26 hours. Check BACKUP_STORAGE_DRIVER is set and the worker is running.

#### DatabaseConnectionsNearLimit

The connections open to the database passed 85, close to the default limit of 100. Raise the limit, shrink the pools or add a pooler before new connections are refused. Adjust the number to 85% of max_connections.

- Severity: `ticket`, area `database`, for 10m.
- Expression: `max(sum by (instance) (db_pool_connections{state=~"used|idle"})) > 85`
- What to do: Compare the open connections with max_connections on the server. Reduce the pool sizes, add a pooler, or raise the limit. Change the number in the rule to 85% of the real limit.

#### DatabaseConnectionsWaiting

A pool has had requests waiting for a free connection for 5 minutes.

- Severity: `ticket`, area `database`, for 5m.
- Expression: `max by (pool) (db_pool_connections{state="waiting"}) > 0`
- What to do: Requests are queuing for a connection. Look for a long query or a leaked transaction first, then at the pool size.

#### MemoryNearLimit

A web or worker pod has used more than 90% of its memory limit for 10 minutes and will be killed when it reaches it. The numbers come from the cluster's container metrics, not from the application.

- Severity: `ticket`, area `runtime`, for 10m.
- Expression: `max by (pod) (container_memory_working_set_bytes{container=~"web|worker"} / container_spec_memory_limit_bytes{container=~"web|worker"}) > 0.9`
- What to do: The pod will be killed at its limit. Look for growth over the last day; raise the limit only after checking for a leak.

#### ErrorReportsSpiking

The same kind of error was reported at more than one a second for 10 minutes.

- Severity: `ticket`, area `runtime`, for 10m.
- Expression: `sum by (kind) (rate(errors_reported_total[10m])) > 1`
- What to do: The kind named in the alert is the first part of the log entry that reported the error; search the logs for it. The request id ties a report to its log lines.

#### CertificateExpiringSoon

The certificate served on a probed address expires in under 14 days and has not been renewed.

- Severity: `ticket`, area `runtime`, for 1h.
- Expression: `probe_ssl_earliest_cert_expiry - time() < 14 * 86400`
- What to do: Check why renewal has not happened (DNS challenge, rate limit, a changed address) and fix it this week.

#### CertificateExpiryImminent

The certificate served on a probed address expires in under 3 days. Renew it now.

- Severity: `page`, area `runtime`, for 5m.
- Expression: `probe_ssl_earliest_cert_expiry - time() < 3 * 86400`
- What to do: Renew by hand now.

#### SecretRefreshFailing

A process failed to refresh its secrets from the secret source for 10 minutes. It keeps the last good values, but a rotated key will not arrive.

- Severity: `ticket`, area `runtime`, for 10m.
- Expression: `sum by (instance) (increase(secret_refresh_failures_total[15m])) > 0`
- What to do: The secret source cannot be reached or refuses us. The process keeps the last good values; check the source's status and our credential for it.

#### ScrapeTargetDown

Prometheus could not scrape a target for 5 minutes: the process is down or its metrics token is wrong.

- Severity: `page`, area `runtime`, for 5m.
- Expression: `up == 0`
- What to do: A web or worker process is down or its metrics token is wrong. Check the pod and the token in the scrape config.

#### ProcessStillDraining

A process reports it is draining for 15 minutes, which is longer than a deploy should take.

- Severity: `ticket`, area `runtime`, for 15m.
- Expression: `max by (service) (process_draining) == 1`
- What to do: A deploy or a shutdown is taking too long. Check what the process is waiting for; kill it only after the drain deadline.

### bhava-slo

#### UptimeBurnFast

The outside probe of webhooks and shopper pages failed so often over 1h (and still over 5m) that a 14.4x burn rate would use the 99.5% monthly objective up early.

- Severity: `page`, area `slo`, for 2m.
- Expression: `(1 - avg by (probe) (avg_over_time(probe_success{probe=~"webhook|shopper_page"}[1h]))) > 0.072 and (1 - avg by (probe) (avg_over_time(probe_success{probe=~"webhook|shopper_page"}[5m]))) > 0.072`
- What to do: The outside probe fails now and has for a while. The objective is 99.5% over 30 days; at this rate it is gone in about two days. Treat as an outage.

#### UptimeBurnSlow

The outside probe of webhooks and shopper pages failed so often over 6h (and still over 30m) that a 6x burn rate would use the 99.5% monthly objective up early.

- Severity: `page`, area `slo`, for 15m.
- Expression: `(1 - avg by (probe) (avg_over_time(probe_success{probe=~"webhook|shopper_page"}[6h]))) > 0.03 and (1 - avg by (probe) (avg_over_time(probe_success{probe=~"webhook|shopper_page"}[30m]))) > 0.03`
- What to do: A slower but sustained failure. Find which probe (webhook or shopper_page) and check what changed.

#### UptimeBurnTicket

The outside probe of webhooks and shopper pages failed so often over 3d (and still over 6h) that a 1x burn rate would use the 99.5% monthly objective up early.

- Severity: `ticket`, area `slo`, for 1h.
- Expression: `(1 - avg by (probe) (avg_over_time(probe_success{probe=~"webhook|shopper_page"}[3d]))) > 0.005 and (1 - avg by (probe) (avg_over_time(probe_success{probe=~"webhook|shopper_page"}[6h]))) > 0.005`
- What to do: A low failure rate that will use the whole budget before the month ends. Look at the probe history for the pattern.

#### ProbeDown

A probed address fails from every probe location for 5 minutes: it is down for everyone.

- Severity: `page`, area `slo`, for 5m.
- Expression: `avg by (probe) (probe_success{probe=~"webhook|shopper_page"}) == 0`
- What to do: The probed address fails from every location. Check DNS, the load balancer and readiness.
