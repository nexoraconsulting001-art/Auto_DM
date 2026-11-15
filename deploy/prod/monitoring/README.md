# Monitoring

Rules, routes, dashboards and the uptime probe, for any Prometheus-compatible stack. Track: monitoring. Empty until that track builds it.

To build here:

- `rules/*.yaml`: Prometheus alert and recording rules. Every metric a rule names is in `src/contracts/metrics.js` (`METRICS`, or `EXTERNAL_METRICS` for what the stack itself provides), and no rule uses a label the catalogue does not give that metric (G-06).
- `rules/tests/*.yaml`: `promtool test rules` files in which each alert fires and then clears (G-06).
- `alertmanager.yaml`: routes by `severity` (`page`, `ticket`) with receivers as placeholders; no address, key or webhook URL in the file.
- `dashboards/*.json`: Grafana dashboards that parse and name only catalogued metrics (G-07). No dashboard has a per-business variable: per-business numbers are in the Platform Console (G-14).
- `probe/`: the outside probe's configuration (a blackbox-style exporter): the webhook address and a shopper page on each platform host, feeding `probe_success`. The uptime objective, its window and the burn-rate alerts are `UPTIME_SLO` in `src/contracts/metrics.js`: 99.5% over 30 days (G-13).

Checked by `promtool check rules`, `promtool test rules` and the dashboard test in `npm run prod:validate`.
