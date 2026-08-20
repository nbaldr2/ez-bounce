# ez-debounce

Self-hosted bulk email verification. Upload a CSV, pre-filter it locally, verify
what's left over SMTP through a [Reacher](https://github.com/reacherhq/check-if-email-exists)
sidecar, and export a cleaned list.

Built for a single VPS with outbound port 25 open. Three containers: Reacher,
Redis, and this app (API + React UI + worker pools in one process).

---

## ⚠️ Read this first: your VPS needs a PTR / rDNS record

**This is not optional, and it is the single most common reason a self-hosted
verifier produces useless results.**

Verifying an address means opening an SMTP conversation with the recipient's mail
server and asking `RCPT TO: <address>` without sending anything. Large providers —
Gmail above all — decide how to answer based on how much they trust the IP
connecting to them. An IP with no reverse-DNS record looks exactly like a
snowshoe spammer, so Google will not give you a straight answer. It will:

- return `421 4.7.0 Try again later` / `450 4.2.1 ... receiving mail at a rate that prevents ...`,
- or accept every address regardless of whether it exists (making everything look
  like a catch-all),
- or drop the connection.

ez-debounce reports those deferrals honestly as **`unknown`**, never as invalid.
That is the correct behaviour, but a run that returns 90% `unknown` has told you
nothing while spending hours doing it.

### What to set up

1. **Reverse DNS (PTR).** In Kamatera's console, set the rDNS for your server's
   public IP to a hostname you control, e.g. `mail.yourdomain.com`.

2. **Matching forward DNS (A record).** That hostname must resolve back to the
   same IP. Providers check both directions (this is "forward-confirmed rDNS").

   ```
   dig -x 203.0.113.45 +short        # -> mail.yourdomain.com.
   dig +short mail.yourdomain.com    # -> 203.0.113.45
   ```

   Both must agree. If either is empty, stop and fix it before running a job.

3. **Set `REACHER_HELLO_NAME` to that exact hostname.** It becomes the SMTP
   `EHLO` name. A `EHLO` that disagrees with the PTR record is a strong spam
   signal.

4. **Set `REACHER_FROM_EMAIL` to a real address on a domain you control.** It
   becomes the `MAIL FROM`. Some servers reject a sender whose domain has no MX
   or SPF record. Add an SPF record for the domain while you're there.

5. **Confirm outbound port 25 is actually open.** Kamatera generally allows it,
   but it is often blocked by default and may need a support ticket.

   ```
   nc -vz gmail-smtp-in.l.google.com 25
   ```

   If that times out, nothing here will work — no amount of tuning fixes a
   blocked port 25.

### Honest expectations for Gmail

Even with perfect rDNS, Gmail is the hardest target:

- Google does not reliably distinguish "mailbox does not exist" from "we don't
  feel like telling you" for a low-reputation IP.
- A brand-new VPS IP has no sending history, so trust starts low.
- Sustained high-rate probing from one IP gets tarpitted regardless of rDNS.

This is why Gmail gets its own deliberately slow worker pool (see below). If you
need high-confidence Gmail results at volume, a residential/rotating-IP
commercial API will beat a single VPS — that is a property of how Google works,
not a limitation of this code.

---

## Quick start

```bash
cp .env.example .env
# Edit .env — REACHER_HELLO_NAME and REACHER_FROM_EMAIL are mandatory.
nano .env

docker compose up -d --build
docker compose logs -f app
```

Open <http://127.0.0.1:3000>.

The app binds to `127.0.0.1` by default because **it has no authentication**. Put
Caddy/nginx with TLS and basic auth in front of it, or reach it over an SSH
tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 user@your-vps
```

Check everything came up:

```bash
curl -s localhost:3000/api/health | jq
```

`reacher.ok` and `redis` must both be true.

---

## How it works

```
CSV ─► pre-filter (local, free) ─► MX lookup per domain ─► provider pool queues
                                                             │
                        ┌────────────────────────────────────┼──────────────┐
                        ▼                                    ▼              ▼
                  verify-gmail                        verify-microsoft  verify-other
                  concurrency 2                       concurrency 3     concurrency 8
                  delay 1500ms                        delay 1000ms      delay 100ms
                        └────────────────┬───────────────────┴──────────────┘
                                         ▼
                                  Reacher sidecar ──► recipient MX (port 25)
                                         ▼
                          classify ─► terminal verdict  ─────► SQLite
                                   └─ 4xx temp-fail ─► requeue w/ backoff
```

### Stage 1 — pre-filter (no network)

Runs before any SMTP traffic and shows you the counts before you commit:

| Check | Notes |
|---|---|
| Syntax | Stricter than RFC 5322, looser than `\S+@\S+`. Rejects only what an MX would certainly reject. |
| Dedupe | Canonicalised. On Gmail, `John.Doe+news@gmail.com` and `johndoe@googlemail.com` are the **same mailbox** and collapse to one check. Dot-stripping is applied *only* to Google consumer domains, since elsewhere `j.smith@` and `jsmith@` are different people. |
| Role accounts | `info@`, `support@`, `noreply@`, `sales.uk@`, `info2@`. Deliverable but reputation-damaging. |
| Disposable | ~500 curated domains, subdomains included. Extend with `DISPOSABLE_DOMAINS_FILE`. |
| Blocked | Your own deny list via `BLOCKED_DOMAINS`. |

On a 100k-row file this takes about a second and typically removes 10–30% of the
list — the cheapest verification you will ever do.

### Stage 2 — provider pools (the part that matters)

Addresses are bucketed by **the MX host they resolve to, not the domain in the
address.** This matters more than it sounds:

```
stripe.com    -> aspmx.l.google.com                  -> gmail pool
shopify.com   -> aspmx.l.google.com                  -> gmail pool
github.com    -> github-com.mail.protection.outlook.com -> microsoft pool
```

Google Workspace and Microsoft 365 custom domains share the same receiving
infrastructure — and the same per-source-IP rate limits — as `gmail.com` and
`outlook.com`. Bucketing on the literal string `@gmail.com` would throttle
consumer Gmail correctly and then get you 421'd anyway by the thousands of
Workspace domains sitting in the "other" pool.

MX resolution is cached per domain, so a 100k list of Gmail addresses costs
exactly one DNS query.

Each pool is one BullMQ queue with **one worker pool** and two independent
limits:

- **`concurrency`** — how many SMTP checks run in parallel.
- **`delayMs`** — minimum spacing between request *starts* across the entire
  pool, enforced by an atomic Redis slot reservation. Workers in any number of
  processes share one timeline, so this is a true global rate limit rather than a
  per-worker sleep.

Effective ceiling per pool:

```
min( concurrency / smtp_latency , 1000 / delayMs )  addresses per second
```

Gmail defaults to `concurrency=2`, `delayMs=1500` → ~1.3/sec. Slow on purpose.

### Stage 3 — temp-fail handling

**A 4xx response is not a verdict.** `421` and `450` from Gmail mean "not right
now"; they say nothing about whether the mailbox exists. Recording them as
`invalid` is how a verifier silently deletes good addresses from your list.

So a temp-fail is re-queued as a fresh delayed job on the same pool:

```
attempt 1 ─(4xx)─► wait 30s ─► attempt 2 ─(4xx)─► wait 2m ─► attempt 3 ─(4xx)─► wait 10m ─► attempt 4
                                                                                              │
                                                                        still 4xx ─► unknown / temp_fail_exhausted
```

Never `invalid`. Configurable via `RETRY_BACKOFF_MS`.

`5xx` responses that look like an **IP-level block** (Spamhaus, "client host
rejected", missing PTR) are also retried rather than trusted, because they
describe *your server*, not the address.

### Result categories

| Category | Meaning |
|---|---|
| `valid` | Reacher confirmed the mailbox accepts mail. Safe to send. |
| `invalid` | Permanent rejection (`550 user unknown`), disabled mailbox, or no MX. Will hard-bounce. |
| `catch_all` | Domain accepts every address. Existence unproven — a judgement call. |
| `unknown` | No verdict. Includes `temp_fail_exhausted` after the full retry schedule. |

The `reason` column carries the detail (`deliverable`, `rejected`, `no_mx`,
`greylisted`, `ip_blocked`, `temp_fail_exhausted`, `full_inbox`, `disabled`, …).

---

## Tuning while a job runs

Open **Settings** in the UI, or:

```bash
# Back off Gmail mid-run
curl -X PATCH localhost:3000/api/settings \
  -H 'content-type: application/json' \
  -d '{"groups":{"gmail":{"concurrency":1,"delayMs":3000}}}'
```

- **Concurrency** reaches the running workers within ~2s.
- **Delay, backoff and timeout** are read fresh for every address, so they apply
  to the very next check.
- Saving also clears the pacing timeline, so *lowering* a delay speeds things up
  immediately instead of after the old reservations drain.

Nothing here requires a restart, and an in-flight 100k job keeps its progress.

### What to watch

The progress screen shows **temp-fail events as a percentage of completed
checks**. That is your tuning signal:

| Temp-fail rate | Action |
|---|---|
| ~0% | You can try raising concurrency by 1. |
| under 5% | Healthy. Leave it. |
| 5–15% | Borderline. Raise `delayMs`. |
| over 15% | You are being throttled. Halve concurrency, double the delay, and re-check rDNS. |

If Gmail temp-fails stay high at `concurrency=1, delayMs=3000` with correct rDNS,
the IP itself is the problem — not the settings.

---

## Configuration

All variables are optional except the two Reacher identity settings. Full list
with comments in [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `REACHER_HELLO_NAME` | *required* | SMTP `EHLO` name. Must match your PTR record. |
| `REACHER_FROM_EMAIL` | *required* | SMTP `MAIL FROM`. Real address on your domain. |
| `GMAIL_CONCURRENCY` | `2` | Parallel Gmail checks. |
| `GMAIL_DELAY_MS` | `1500` | Min ms between Gmail request starts. |
| `MICROSOFT_*`, `YAHOO_*`, `APPLE_*`, `PROTON_*`, `OTHER_*` | see `.env.example` | Same pair per pool. |
| `RETRY_BACKOFF_MS` | `30000,120000,600000` | Temp-fail backoff schedule. |
| `REACHER_TIMEOUT_MS` | `45000` | Per-request timeout to the sidecar. |
| `BLOCKED_DOMAINS` | — | Extra domains to drop, comma separated. |
| `DISPOSABLE_DOMAINS_FILE` | — | Newline-delimited list merged with the built-in one. |
| `MAX_UPLOAD_MB` | `250` | Upload size cap. |
| `MX_CACHE_TTL_SECONDS` | `86400` | MX lookup cache TTL. |
| `DISABLE_MX_GROUPING` | `false` | Bucket on address domain only (skips DNS). |
| `BIND_ADDR` / `HOST_PORT` | `127.0.0.1` / `3000` | Where the UI is published. |

---

## API

```
GET    /api/health
POST   /api/uploads                    multipart "file" -> column detection
POST   /api/uploads/:id/analyze        run pre-filter   -> counts
GET    /api/uploads/:id
POST   /api/jobs                       { uploadId }     -> 202 { jobId }
GET    /api/jobs/:id/status            poll this every 2s
POST   /api/jobs/:id/pause|resume|cancel
GET    /api/jobs/:id/results           ?category=&group=&q=&limit=&offset=&sort=&dir=
GET    /api/jobs/:id/summary           counts by category and reason
GET    /api/jobs/:id/export            ?mode=valid_only|safe_to_send|all_labeled
                                       &includeColumns=&includePrefiltered=
GET    /api/settings
PATCH  /api/settings
POST   /api/settings/reset
```

`POST /api/jobs` returns `202` immediately (measured at 11ms for an 85,000-address
job); queueing and MX resolution continue in the background. Export streams from
SQLite with a cursor, so a 100k-row CSV download uses constant memory.

### Export modes

- `valid_only` — just the confirmed-deliverable addresses.
- `safe_to_send` — valid + catch-all.
- `all_labeled` — every address with `category`, `reason`, pool, attempts and SMTP
  code. Add `includePrefiltered=true` to append the rows dropped before SMTP.

`includeColumns=true` carries the original CSV columns through to any mode.

---

## Local development

```bash
# Redis
docker run -d -p 6379:6379 redis:7-alpine
# Reacher
docker run -d -p 8080:8080 \
  -e RCH__HELLO_NAME=mail.yourdomain.com \
  -e RCH__FROM_EMAIL=verify@yourdomain.com \
  reacherhq/backend:latest

cd server && npm install && npm run dev     # :3000
cd web    && npm install && npm run dev     # :5173, proxies /api
```

---

## Operational notes

- **Data.** Results live in SQLite on the `app-data` volume; the queue lives in
  Redis on `redis-data` (AOF enabled, so a part-finished job survives a restart).
  Back up both, or neither.
- **Restarts and crashes are safe.** A running job resumes by itself — no manual
  step. Addresses that were mid-check when the process died are stuck in the
  queue's `active` set until their lock expires, so expect a **~2.5 minute pause
  near the end of the run** before the last few are reclaimed and finished. The
  lock window is derived from `REACHER_TIMEOUT_MS`, and reprocessed addresses are
  de-duplicated, so counts stay exact.
- **Memory.** Peak RSS on a 100k-row list is ~190 MB, dominated by the dedupe
  set. A 1 GB VPS is enough for 100k; for much larger lists either split the file
  or raise `NODE_OPTIONS=--max-old-space-size`.
- **Reacher is unauthenticated** and will verify anything for anyone who can
  reach it. The compose file keeps it on the internal network with no published
  port. Leave it that way.
- **Pin the Reacher image** once you have a working combination
  (`REACHER_IMAGE=reacherhq/backend:<tag>`). `latest` moves, and upstream has
  changed its configuration and licensing between releases — if the container
  exits at boot, read `docker compose logs reacher` first, since it may be asking
  for config this compose file does not set.
- **Rate limits are per source IP.** Running two instances from the same IP
  doubles your effective rate and defeats the pacing. Scale by adding IPs, not
  containers.
- **Sending is out of scope.** This tool only verifies. A clean list still needs
  proper warm-up, SPF/DKIM/DMARC and sane volume ramping.

## Legal

Verifying addresses you have no relationship with, and cold-mailing the result,
is regulated in most jurisdictions (GDPR, CAN-SPAM, CASL). Have a lawful basis
for processing before you upload anything.
