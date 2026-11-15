# DNS and the cut-over, with Cloudflare in front

Cloudflare proxies the platform's hosts (`<platform domain>`, `*.<platform domain>`, `app.`, `admin.`). It ends visitors' TLS and reaches our ingress (or the compose host's load balancer) over TLS with a Cloudflare origin certificate. Sellers' own domains point at us directly or through Cloudflare for SaaS, and get certificates on demand.

## Settings that must be right before any switch

1. **TLS mode:** SSL/TLS "Full (strict)". Never "Flexible" (it sends visitors' traffic to us unencrypted) and never "Full" without strict. Turn on "Always Use HTTPS" and minimum TLS 1.2.
2. **Origin certificate:** a Cloudflare origin certificate for `<platform domain>` and `*.<platform domain>`, as the Secret `bhava-origin-tls` (Kubernetes) or `lb/origin.crt` and `lb/origin.key` (compose).
3. **The visitor's address:** the compose load balancer trusts only Cloudflare's published ranges (`TRUSTED_PROXY_RANGES`) and takes `CF-Connecting-IP`; on Kubernetes, configure the ingress controller the same way. The app trusts exactly one proxy, so per-visitor limits stay per visitor.
4. **Caching:** a Cache Rule that bypasses the cache for `/api/*`, `/webhook`, `/webhooks/*`, `/oauth/*`, `/auth/*`, `/tls/ask` and anything with a session cookie. Shopper pages may be cached only as the app's own headers allow.
5. **Sellers' own domains (on-demand certificates).** The load balancer asks the app `GET /tls/ask?domain=<host>` before it gets a certificate; only a verified domain of an open business is approved, so nobody can make us issue certificates for hosts we do not serve. With Cloudflare for SaaS instead, the custom hostname is added there when the seller verifies it, with the platform's fallback origin; keep `/tls/ask` as the rule for which hosts may be added.
6. **DNS TTL** of every record that will move: 300 seconds, at least one old TTL before the switch.

## The addresses registered with providers

These do not change if the platform hosts keep their names (the usual case: only the records behind them move). If a host name changes, update each before the switch and keep the old one answering until the provider shows deliveries to the new one.

| Provider | Address | Where it is set |
|---|---|---|
| Meta (Instagram and Facebook webhooks) | `https://<platform host>/webhook` | App dashboard, Webhooks |
| Meta login callbacks | `/oauth/instagram/callback`, `/oauth/facebook/callback`, `/meta/deauthorize`, `/meta/deletion` | App dashboard, Login settings (`META_CALLBACK_BASE_URL`) |
| WhatsApp Cloud API | `https://<platform host>/webhooks/whatsapp` | WhatsApp configuration |
| Payments for sellers' orders | `https://<platform host>/webhooks/razorpay` | Payment provider's webhook settings |
| Billing of Bhava's own plans | `https://<platform host>/webhooks/billing/razorpay` | Payment provider (billing account) |
| Courier | `https://<platform host>/webhooks/courier` | Courier provider's webhook settings |
| Shopify (catalogue sync) | `https://<platform host>/webhooks/shopify` | Shopify app settings |
| Google sign-in | `https://<platform host>/auth/google/callback` | Google client's redirect addresses |

## The cut-over order

1. Lower TTLs (above) a day ahead, and check the new site answers on its own address: `curl -s --resolve <platform host>:443:<new origin address> https://<platform host>/readyz` answers `up`.
2. Put the old site into maintenance and finish the data move ([move-from-vm.md](move-from-vm.md)) up to "verify" passing.
3. **Switch the proxied records** for the platform hosts to the new origin (Cloudflare: change the origin record; proxied records switch at Cloudflare's edge within seconds).
4. **Switch sellers' domains** that point at us directly (they CNAME to a platform host, so they follow step 3; any with an A record pointing at the old address must be changed by the seller: the Platform Console lists them).
5. **Webhooks:** send a test delivery from each provider in the table (Meta's "Test" button, the payment provider's test webhook, the courier's) and see it in the new site's webhook metrics (`webhook_received_total`).
   Check: each provider shows `accepted`; no delivery goes to the old site (its access log is quiet).
6. End maintenance. Watch the dashboards for an hour: error rate, webhook intake, queue depth, sends.

## How to go back

1. Before the old site has taken any new write: switch the records of step 3 back to the old origin and start the old site. Done within a TTL.
2. After the new site took writes: decide with the owner. Going back then means carrying those orders back by hand; usually fix forward instead.
3. Provider addresses: if any host name changed, put the old addresses back in each provider's settings; the old site still answers them.
