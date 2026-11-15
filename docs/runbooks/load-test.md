# Load test

`npm run load` proves the platform holds a stated amount of traffic inside the QA server's limits. It runs on the build machine, never on the VM, and sends nothing outside this machine.

## What it does

1. Starts a Postgres with the QA server's settings (`shared_buffers=128MB`, `max_connections=40`) and its two logins.
2. Makes 10 businesses (a business, its owner, an Instagram account at the simulator, four products, a live comment automation, payments ready through the console API and the simulator's KYC).
3. Starts the web app and the worker as two separate Node processes with the heap limits for 512 MB and 384 MB. Memory is read from the operating system every 2 seconds.
4. Drives the mix in `tools/load/budgets.json` through the simulators for the stated time, then writes `test-results/load/report.md` and `report.json`.

The request rate is `run.requestsPerSecond`, split by the mix weights. It is open loop: requests start on schedule whether or not earlier ones finished, and each is timed from when it was due, so a slow server shows as slow answers.

| Class | What is sent |
|---|---|
| buyer_page | the store's pages on a business's own address (home, shop, product, about) |
| beacon | the traffic beacon those pages call |
| webhook | signed Meta webhooks, 70% comments (a keyword that gets a DM) and 30% DMs |
| store_api | product look-ups, price quotes, and checkouts that are then paid at the Razorpay simulator, which sends the payment webhook back |
| seller_api_read | reads on the seller API with a seller's token |
| seller_api_write | writes on the seller API |

Insights polling, order events and the compliance queue run in the worker on their own and are part of the load.

## Run it

```bash
npm run load                           # all three parts, 120 s of mix (about 10 minutes with the set-up)
npm run load -- --part mix             # one part: mix, storm or restart (repeat the flag for two)
npm run load -- --seconds 30           # shorter; the report says it is not a pass of record
npm run load -- --out before-change    # report folder under test-results
```

Exit code 0 is a pass. 1 is a failed check, or a run that did not finish. 2 is a mistake in how it was started. Each check prints on its own line with the measured value and the limit.

## The three parts

- **mix (Q-05).** No failed request, p95 per class inside `p95Ms`, and web, worker and database each inside their memory limit. Every webhook answered 200 must be stored and handled, and no message may go out twice.
- **storm (Q-06).** 2,000 comments on one business over 60 seconds on top of the normal mix. The other nine are judged: page p95 no more than 1.5 times what the same pages did in the 15 seconds before (a baseline under 100 ms counts as 100 ms), and DM send delay p95 under 30 seconds. The stormed business may be slow: the compliance gate lets one Instagram account start one conversation a second and send 600 private replies an hour, so 2,000 comments cannot all be answered in a minute or even an hour. That is the gate working, not a failure; the report says how many of its DMs had gone out when the wait ended. What is judged is the others: no DM of theirs may be left waiting after twice the send-delay limit (60 seconds with the real budget), and every webhook of theirs must be stored and handled.
- **restart (Q-07).** Web and worker are killed hard 30 seconds in and started again. A webhook that is not answered is sent again every half second, as Meta does. Afterwards every webhook that was answered 200 must be in `inbound_events` and handled (lost 0), no comment may have two DMs (counted from the Meta simulator's own record and from the send queue), the processes must be answering within 30 seconds, and nothing may fail after they are back.

## Reading the report

`report.md` lists each check with the number and the limit. `report.json` also has the memory, queue and database-answer peaks, per-class p50, p95 and p99, and the host's idle probe. The machine matters: read "idle probe" first. A host that answers an idle `/healthz` slowly was busy, and a failed p95 on such a run proves little (run it again when the machine is quiet). The limits themselves are never relaxed.

Margins used, in one place: p95 and memory limits are applied exactly as written; the storm's page limit is relative to the run's own baseline with the 100 ms floor above; a latency check needs at least 20 answers; memory with no reading fails. The simulators and the traffic share the machine with the system under test.

## When a check fails

| Failed check | Look at |
|---|---|
| p95 of one class | which route in `src/modules`; `report.json` `data.peaks.dbMs` (a slow database answer points at queries or the connection pool) |
| memory | the process named; run with `--part mix` only and watch whether it climbs |
| lost webhooks | `inbound_events` (a webhook is stored before the 200 goes back); the lost ids are in `report.json` as `lostSample` |
| sent twice | `outbound_jobs` for the comment id, and the compliance queue's lease handling after a kill |
| back within 30 s | start-up work in the web app and the worker (migrations, first connection) |

## Change a limit

Only in `tools/load/budgets.json`, with a reason in the commit. Memory and the Postgres settings must stay equal to `deploy/bhava/compose.yaml` (`test/p8/contract` checks it).

## Repeat on the QA server later

The tool makes its own Postgres and processes on free ports, so it can run on the VM's machine without touching the `bhava` containers. Do it only when the owner of the shared VM agrees, in a quiet window, because it will use about 1.5 GB and all the CPU it can get, which slows the other sites.

1. `free -h` shows at least 2 GB free, and `uptime` shows the machine is quiet.
2. In a separate clone (not `~/bhava`): `git checkout bhava/build`, `npm ci`.
3. `npm run load -- --out qa` and read `test-results/qa/report.md`.
4. `ps` shows no `postgres` or `node` process of the run left behind.

Numbers from the VM are for the VM. Do not compare them with the build machine's; compare a run with the previous run on the same machine.
