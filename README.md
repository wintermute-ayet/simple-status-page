# Simple Status Page

## Introduction

**Simple Status Page** is a Koa.js and React Vite monitoring application for tracking the status of
services through HTTP and API endpoints. It uses SQLite for storage and a YAML file for
configuration, and can be deployed with Docker. The frontend uses native HTML controls and CSS.

## Features

- **Monitor Types:** 'http' for checking HTTP endpoints and 'api' for receiving external status
  updates.
- **Docker Deployment:** Easy setup with Docker and Docker Compose.
- **Customizable Configuration:** Managed through a single YAML file.
- **Automatic Database Migrations:** Persisted monitor state and daily uptime history in SQLite.
- **Snapshot Frontend:** Initial status without an API call, conditional polling and accessible
  history.

Unimplemented features are listed in the [roadmap](#roadmap).

## Frontend Screenshots

These reference screenshots predate the frontend overhaul:

| ![Desktop View](img/desktop.png) | ![Mobile View](img/mobile.png) |
| :------------------------------: | :----------------------------: |
|           Desktop View           |          Mobile View           |

## Monitor Types and Functionality

**Simple Status Page** currently supports two primary types of monitors: `http` and `api`. Each type
has its unique way of monitoring and reporting the status of your services.

### HTTP Monitor

HTTP monitors check the configured URL and allowed status codes. An optional regular expression
checks the response text; it is compiled once at startup. Each request has a timeout, a 1 MB body
cap, a five-redirect limit and its own User-Agent. When a regexp is configured, content types must
be text, JSON, XML or JavaScript; a missing content type is treated as text.

A successful response taking more than `timeoutDegradedMs` milliseconds is degraded. A rejected or
failed response counts toward `retries`: after that many consecutive failed checks, down is
recorded. Successful checks reset retries. Elapsed milliseconds are stored as the check value.
Checks do not overlap. The first HTTP check starts with a deterministic offset per monitor id,
bounded by the smaller of 10% of `checkInterval` and 1000 ms; subsequent checks wait `checkInterval`
after the previous run finishes. The minimum interval is 1000 ms. Below the retry threshold, a
failed HTTP check saves state and resets the recovery streak for degraded incidents, while
preserving the recovery streak for down incidents.

### API Monitor

API monitors receive external reports through the [push API](#push-monitors). Accepted reports are
persisted immediately; the public snapshot reflects them at the monitor's scheduled check. A report
is fresh for `retries * checkInterval` milliseconds. Once it is stale, the missing-report retry
counter advances on each check. At the retry threshold, `onMissing: down` records down, while
`onMissing: unknown` records no data. A fresh report resets retries and restores its reported
status, including after a long outage. A monitor that has never reported also follows this
missing-data rule.

The optional finite numeric `value` defaults to zero. It is stored with checks for future metrics
use and is not graphed by the current frontend.

### Monitor Status and Incidents

Both types support optional incident rules for `down` and `degraded`:

- `createAfter` counts consecutive recorded checks of that incident type.
- For down incidents, `resolveAfter` counts consecutive **up or degraded** checks.
- For degraded incidents, `resolveAfter` counts consecutive **up** checks only. Degraded, down and
  unknown reset this healthy streak; down and unknown also reset the outage recovery streak.
- Both counters must be positive to enable a rule; setting either to zero disables that incident
  type. A failure meeting `createAfter` takes precedence and keeps the incident active.

A recovered outage can leave a separate performance incident active. `visible: false` hides a
monitor from the public snapshot and prevents automatic incident creation/resolution for it; its
checks still run. Incident messages are plain text, with preserved line breaks and legacy `<br>`
separators rendered safely. These rules create database incidents; mail notifications require SMTP
and confirmed subscribers.

## Configuration Guide

Start with [data/config.example.yml](data/config.example.yml), which documents every accepted key
and includes HTTP and API monitors. Copy it to `data/config.yaml` or `data/config.yml`, then replace
the example salt, tokens, URLs and any SMTP placeholders before deployment. SMTP is commented out in
the example so it sends no mail by default.

Config lookup is `CONFIG_PATH`, then `data/config.yaml` if present, otherwise `data/config.yml`.
Relative paths resolve from the process working directory. Startup validates YAML before opening
SQLite: unknown keys, duplicate ids or API tokens, tokens shorter than 16 characters, invalid
regexps and groups referencing missing monitors are errors.

| Block/key                | Meaning                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public`                 | SVG favicon/logo, company name, public base URL and legacy refresh setting. This block is public; put no credentials here.                                         |
| `public.basedomain`      | Absolute HTTP(S) base URL used in mail links; independent of request Host headers. Use the external HTTPS URL behind nginx.                                        |
| `public.refreshInterval` | Legacy value in seconds, retained for API compatibility. The bundled frontend polls every 45 seconds while visible.                                                |
| `salt`                   | Private subscription-signing secret; see [upgrade notes](#upgrade-notes).                                                                                          |
| `dailyThresholds`        | `down` and `degraded` fractions from 0 to 1, defaults `0.001` and `0.005`. A day's failure fraction must exceed its threshold. Down takes precedence.              |
| `database.path`          | SQLite file path; its directory must exist and be writable, including for WAL/SHM files.                                                                           |
| `smtp`                   | Optional mail host, sender, port and paired username/password. Omit to hide subscriptions and disable new subscription requests.                                   |
| `proxy`                  | Top-level boolean, default `false`; controls Koa's `app.proxy`. Enable only behind a trusted proxy that replaces forwarded headers.                                |
| `cors`                   | Top-level list of allowed HTTP(S) origins, default `[]` (CORS off). No wildcards, paths or queries. For example, `["https://example.com"]`.                        |
| `groups`                 | Named lists of existing monitor ids, defining the public page's grouping.                                                                                          |
| `monitors`               | Unique id/name, type, visibility, description, uptime label, intervals, retries, HTTP options or API credentials/missing-data policy, and optional incident rules. |

SMTP accepts only `host`, `from`, `port`, `username` and `password`. Supply username/password
together or leave both empty. Transport `secure` is derived from the port, and recipients (`to`)
come from subscriptions; `smtp.secure` and `smtp.to` are not YAML options. The `proxy` and `cors`
keys are at the root, without an `app` block.

## Building and Running the Project

### Prerequisites

- Node.js 24 for the documented build and deployment workflow. CI and the pinned container use 24;
  `package.json` declares an engine floor of `>=20`.
- npm

### Installation

1. Clone the repository.
2. Install dependencies for backend and frontend:
   ```sh
   npm run deps
   ```

### Building the Application

Build both the backend and frontend:

```sh
npm run buildall
```

### Running the Application

Start the server:

```sh
npm run start
```

## Running with Docker Compose

1. Install Docker with the Compose plugin, then prepare the configuration:

   ```sh
   cp data/config.example.yml data/config.yaml
   ```

   Edit it for your services. Grant the image's non-root `node` user read access to the private
   config and write access to `data/` for SQLite and its sidecar files. Match the bind mount's
   ownership to that user; keep credentials and database backups private.

2. Run the [preflight checks](#preflight-checks) before deploying, then start the service:

   ```sh
   docker compose up -d --build
   curl -fsS http://127.0.0.1:3000/healthz
   ```

Compose publishes only `127.0.0.1:3000:3000`; nginx exposes the public endpoint. It uses
`restart: unless-stopped`, `init: true` and `stop_grace_period: 15s`. The server's graceful shutdown
deadline is 10 seconds. The root filesystem is read-only, `./data` is the writable persistent mount,
and `/tmp` is a 16 MB tmpfs with `noexec,nosuid`; `SQLITE_TMPDIR` keeps SQLite temporary files on
the data mount. All Linux capabilities are dropped, new privileges are disabled, memory is limited
to 512 MB, and JSON logs rotate at 10 MB with three files.

The multi-stage image pins `node:24-slim` by digest, keeps production dependencies only, runs
`node dist/server.js` as `node`, and checks `/healthz`. For a direct Node deployment, an equivalent
loopback listener can be selected with `HOST=127.0.0.1 PORT=3000 npm start`. In containers, the
default internal listener accepts connections on all interfaces; the Compose port mapping controls
host exposure. `HOST`/`PORT` override the listener, and `PORT` must be an integer from 1 to 65535.

## Upgrade Notes

Stop the previous service and take a consistent SQLite backup and a private copy of its config
before the first upgraded start. Use the configured `database.path`; for the example path, with the
SQLite CLI installed on the host:

```sh
docker compose stop
sqlite3 data/database.sqlite '.backup data/database.pre-overhaul.sqlite'
```

Keep the old image and backup for rollback; restore the backup when rolling back a schema upgrade.
Validate the updated config and allow time and disk space for the initial migration/backfill before
starting the new version.

- **Timeout alias:** `timeoutDegradationMs` is accepted with a deprecation warning. Rename it to
  **`timeoutDegradedMs`**, the canonical key. Both are milliseconds: a successful HTTP response
  exceeding this duration is degraded (default 1000 ms); `timeoutDownMs` is the request deadline
  (default 5000 ms). The degraded threshold must not exceed the down timeout. The canonical key wins
  if both are set. `timeoutDegradation` is not an accepted key.
- **State and history:** Migration 3 creates `monitor_state` for last reports, retry counts and
  incident streaks, loads the latest stored checks, and permits `unknown` in raw history. Migration
  4 creates `monitor_daily` and performs a one-time backfill of the last 91 UTC dates from raw
  checks. Migrations run at startup and record completion transactionally; repeated starts do not
  double-count. The backfill replaces counts on conflict, so it is idempotent. New checks update raw
  history, daily counters and runtime state together. Keep monitor ids stable across upgrades.
- **Token rotation:** The primary API credential is **`uuid`**, alongside optional `tokens: []`;
  there is no singular `token` config key. All entries authenticate the same monitor and must be
  globally unique, at least 16 characters long. Add a new random token to `tokens`, restart, switch
  reporting clients, and check monitor ids/token slots to confirm the handover. Then promote the
  replacement to `uuid`, remove the old credential and restart. Never log tokens or Authorization
  headers; omit push URLs from proxy access logs. Comparisons use fixed-size SHA-256 digests and
  constant-time comparison. Logs identify only the monitor and zero-based slot (`uuid` is slot 0).
- **Subscription salt:** At least 32 characters are required **when SMTP is configured**. Existing
  SMTP configurations using a shorter salt **now refuse to start**; replace that salt with a new
  secret of at least 32 characters. Keep a valid existing secret to preserve links, including when
  disabling SMTP. Confirmation links now use purpose-bound HMAC-SHA256 and expire after 48 hours;
  legacy confirmations are no longer accepted. Legacy unsubscribe links remain accepted **with the
  original salt**. Rotating salt invalidates outstanding confirmations and both new and legacy
  unsubscribe links; old secrets are not retained. Subscribers may need to re-confirm after
  rotation.
- **SMTP:** Optional; without it the subscribe button is hidden and `POST /api/subscribe`
  returns 404. Transport `secure` is true only for port 465 (implicit TLS); 587 requires STARTTLS;
  25 sets neither implicit TLS nor required STARTTLS, although the mail library may negotiate
  STARTTLS if offered. Configure the port, without adding a `smtp.secure` key.
- **Runtime and network:** Use Node 24 for this deployment workflow; the package engine constraint
  remains `>=20`. Preserve Compose's 15-second stop grace period. Both `.yaml` and `.yml` configs
  are supported with the lookup order above. Reapply any `HOST`/`PORT` overrides. Keep top-level
  `proxy: false` unless requests pass through a trusted reverse proxy; CORS remains off with
  `cors: []` unless explicit browser origins need access.

### Enabling Incremental Space Reclamation

New SQLite files enable incremental auto-vacuum. Existing databases created with `auto_vacuum=NONE`
still reuse freed pages internally but need a one-time rebuild to let cleanup shrink the file.
Startup does not run a full `VACUUM`. During maintenance, with the service stopped and a backup
available, inspect and change the database using one connection:

```sh
sqlite3 data/database.sqlite 'PRAGMA auto_vacuum;'
# If the result is 0 (NONE), enable incremental mode and rebuild once:
sqlite3 data/database.sqlite \
  'PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA auto_vacuum;'
```

The final result should be `2` (INCREMENTAL). `VACUUM` alone can reclaim space once, but does not
change a `NONE` database to incremental mode. Subsequent cleanup uses bounded incremental vacuum; no
repeated full rebuild is needed. The one-time rebuild needs maintenance time and free disk space,
potentially up to twice the original database size. See SQLite's
[auto-vacuum](https://www.sqlite.org/pragma.html#pragma_auto_vacuum) and
[VACUUM](https://www.sqlite.org/lang_vacuum.html) documentation.

## Optional: Setting Up Nginx Reverse Proxy with HTTPS (Debian/Ubuntu)

This single-proxy example assumes nginx connects to the service through the loopback Compose
binding. Set top-level `proxy: true` in YAML so Koa uses the forwarded client IP and scheme, and set
`public.basedomain: "https://example.com"` for subscription links. Keep direct backend access
restricted to trusted local callers.

### Step 1: Install Nginx and Certbot

1. Update your package list:
   ```sh
   sudo apt-get update
   ```
2. Install Nginx:
   ```sh
   sudo apt-get install nginx
   ```
3. Install Certbot and the Nginx plugin:
   ```sh
   sudo apt-get install certbot python3-certbot-nginx
   ```

### Step 2: Configure Nginx

Create a new Nginx server block configuration:

1. Go to the `sites-available` directory:
   ```sh
   cd /etc/nginx/sites-available/
   ```
2. Create a new configuration file (e.g., `simple-status-page`):
   ```sh
   sudo touch simple-status-page
   sudo nano simple-status-page
   ```
3. Add the following configuration:

   ```nginx
   server {
       listen 80;
       server_name example.com; # Replace with your domain
       server_tokens off;

       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header Connection "";
       proxy_connect_timeout 5s;
       proxy_send_timeout 15s;
       proxy_read_timeout 60s;

       # Push URLs contain tokens; subscription links contain addresses/signatures.
       location ~* ^/api/(monitor|confirm-subscription|unsubscribe)(/|$) {
           access_log off;
           proxy_pass http://127.0.0.1:3000;
       }

       location / {
           proxy_pass http://127.0.0.1:3000;
       }
   }
   ```

   `X-Forwarded-For $remote_addr` replaces any incoming forwarded chain with nginx's actual client
   address. With Koa trusting this one proxy (`maxIpsCount=1`), clients cannot spoof the
   subscription rate limiter's IP by supplying their own header. Keep this replacement when adapting
   the example; `$proxy_add_x_forwarded_for` appends the incoming chain. The nginx
   [proxy header reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)
   describes the header variables. If other proxies precede nginx, establish that separate trust
   boundary before enabling forwarded-header trust.

4. Enable the configuration by linking it to the `sites-enabled` directory:
   ```sh
   sudo ln -s /etc/nginx/sites-available/simple-status-page /etc/nginx/sites-enabled/
   ```
5. Test the configuration for syntax errors:
   ```sh
   sudo nginx -t
   ```
6. Reload Nginx to apply the changes:
   ```sh
   sudo systemctl reload nginx
   ```

### Step 3: Obtain SSL Certificate with Certbot

1. Run Certbot to get an SSL certificate and configure Nginx to use HTTPS:

   ```sh
   sudo certbot --nginx -d example.com
   ```

   Replace `example.com` with your domain name.

2. Follow the prompts to configure your certificate. Certbot will automatically modify your Nginx
   configuration to serve your site over HTTPS.

### Step 4: Automatic Certificate Renewal

Ensure Certbot's cron job or systemd timer is enabled to renew certificates near expiration. Test
the renewal process with:

```sh
sudo certbot renew --dry-run
```

## API Reference

Read endpoints are public. The snapshot is suitable for the bundled frontend and external clients;
it excludes monitor URLs/tokens, SMTP settings and salt. External browser consumers need their
origin in `cors`; server-to-server clients do not need CORS.

| Endpoint                   | Response/contract                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/status`          | Public config (including `subscriptionsEnabled`), groups, visible monitors with current status/uptime/91-day history, active/recent incidents, and `updatedAt`. |
| `GET /healthz`             | 200 with `{"status":"ok"}` while the HTTP service responds; this is process liveness, not a check that all monitored services are up.                           |
| `GET /api/overview`        | Retained legacy overview response.                                                                                                                              |
| `GET /api/monitor?id=<id>` | Retained legacy daily history. Invalid ids return 400; unknown/hidden monitors return 404.                                                                      |
| `GET /api/incidents`       | Retained legacy incident list.                                                                                                                                  |

### Snapshot Caching

`/api/status` is served from an in-memory snapshot with prebuilt JSON, gzip and Brotli bodies. It
runs no SQLite query or serialization/compression per request. Content encoding is negotiated from
`Accept-Encoding` (`gzip`/`br`), with a weak ETag shared across encodings. Send that ETag in
`If-None-Match` to get 304 with no body when unchanged. Responses include `Vary: Accept-Encoding`
and `Cache-Control: public, max-age=15, stale-while-revalidate=60`. Other API routes use `no-store`.

### Push Monitors

Prefer HTTPS POST with a Bearer token. The legacy GET contract remains supported for existing
reporters; its credential is in the URL path and its report fields are query parameters.

```sh
curl --request POST https://example.com/api/monitor \
  --header 'Authorization: Bearer <monitor-token>' \
  --header 'Content-Type: application/json' \
  --data '{"status":"up","value":1}'
```

| Method/path                                  | Input                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/monitor/<token>?status=up&value=1` | URL token plus query fields.                                                   |
| `POST /api/monitor`                          | `Authorization: Bearer <token>` plus JSON `{"status":"up","value":1}`.         |
| `POST /api/monitor/<token>`                  | Also accepted; the path and Bearer credentials must identify the same monitor. |

`status` must be `up`, `degraded` or `down`. `value` is optional (defaults to zero) and must parse
as a finite number. POST also accepts report fields in the query when its body has no `status`
field. Accepted reports return 200 with `{"status":"ok"}`.

| Failure                                                                            | Status                               |
| ---------------------------------------------------------------------------------- | ------------------------------------ |
| Missing, malformed or unrecognized POST Bearer credential                          | 401 with `WWW-Authenticate: Bearer`. |
| Unknown GET URL token, or a POST path token not matching the authenticated monitor | 404.                                 |
| Invalid status or supplied non-numeric, non-finite or empty value                  | 400.                                 |

An unknown Bearer token is an authentication failure (401), not the GET route's unknown-token 404.
Keep URL credentials and Authorization headers out of application, client and proxy logs.

### Subscriptions

`POST /api/subscribe` accepts JSON `{"email":"<email-address>"}` with
`Content-Type: application/json`; replace the placeholder with one valid address. Successful
requests return 200 with `{"status":"ok"}` and send a confirmation unless already active. Pending
subscriptions can request confirmation again. Invalid or oversized addresses return 400; addresses
are limited to 254 UTF-8 bytes. JSON/form bodies above 16 KB return 413. SMTP disabled returns 404.
Mail delivery failure returns a controlled 503 without stopping the service.

With SMTP enabled, every attempt counts toward **5 requests per IP per 15 minutes** and **100
globally per hour**. Rate-limited requests return 429 with `Retry-After` in seconds. Counters are in
memory and reset on restart. Trusted proxy setup is necessary for accurate client IPs behind nginx.

Mailed links go to `GET /api/confirm-subscription` and `GET /api/unsubscribe`, binding the address,
purpose and expiry with HMAC-SHA256 and constant-time comparison. Confirmations expire after 48
hours; unsubscribe links use `expires=0` and do not expire while the signing salt stays the same.
Valid and invalid links redirect to the page with a result message. Legacy unsubscribe hashes are
accepted with the unchanged salt, including when SMTP is absent; see [upgrade notes](#upgrade-notes)
for rotation effects.

## Mail and Operational Diagnostics

Delivery is queued (at most 100 outstanding messages), limited to 10 seconds per attempt and retried
at most twice, with 250 ms then 500 ms backoff. Closing the queue cancels pending retry delays. All
mail sends are awaited and caught. Confirmations and incident notices include `List-Unsubscribe`;
recipients come from the subscriber list, not a fixed config `to` field. Nodemailer 10.5.0 supplies
its own TypeScript declarations.

HTTP failures log error codes, response status and diagnostic messages; fatal errors and server
failures include stacks. Configured credentials, Bearer values and push URL tokens are redacted.
Global rejection/exception handlers close the service gracefully. Fatal shutdown arms an unref'd
15-second exit deadline for lingering handles. Normal shutdown cancels outstanding work and closes
SQLite within a 10-second deadline; Compose allows 15 seconds before stopping it.

The CSP restricts scripts and styles to same-origin files; the frontend needs no inline exception.
Other headers prevent framing and MIME sniffing and suppress referrer information. HSTS is sent only
over HTTPS, including HTTPS reported by a trusted proxy.

### Dependency audit follow-up

Non-force `npm audit fix` was run for both projects, followed by an explicit Nodemailer upgrade to
10.5.0. The lockfile resolves `validator` to 13.15.35. Reports on 2026-11-10 are:

| Project              | Remaining report                                                             | Follow-up                                                                                       |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Server production    | Zero findings after upgrading Nodemailer to 10.5.0                           | `npm audit --omit=dev` exits 0: `found 0 vulnerabilities`.                                      |
| Server development   | 10 moderate package findings from minimatch through ESLint/typescript-eslint | Review the toolchain dependency upgrade when a compatible fix is available.                     |
| Frontend production  | Zero findings after removing the router and form dependencies                | `npm audit --omit=dev --prefix frontend-vite` exits 0: `found 0 vulnerabilities`.               |
| Frontend development | Vite: 1 high; esbuild and the plugin-react dependency chain: 2 moderate      | Update the frontend build toolchain separately; the suggested audit fix changes major versions. |

The full server audit reports 10 moderate development findings from
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) through the lint toolchain;
these packages are excluded from the production image. The full frontend audit reports 3 development
findings (2 moderate, 1 high), while its production-only audit is clean. Full development audits
still exit 1; no forced upgrades were applied. The frontend slimming removes React Router, Zod and
their advisory chains entirely. Vite/esbuild findings affect development tooling; production serves
static assets through Koa. CI continues to report both production audits.

## Daily history, snapshots and preflight checks

The migration backfill uses the existing timestamp index to bound one SQL aggregation to the last 91
UTC dates (90 days ago through today). Unknown checks remain in raw history/state but add no daily
samples. Missing or zero-count days have null uptime and an explicit "no data" label; overall uptime
averages only days with known checks. Degraded checks count toward uptime. Calendar-day summaries
apply the configurable daily thresholds.

SQLite uses WAL, `synchronous=NORMAL`, a 5-second busy timeout, and the `(monitor_id, created)`
index. Cleanup still removes raw checks older than 91 days, trims expired daily buckets and requests
a bounded incremental vacuum. New files enable incremental auto-vacuum before creating tables. See
the upgrade notes for existing files that need a one-time rebuild.

The in-memory snapshot is rebuilt at startup, after recorded check/incident changes and after
cleanup. Its HTTP caching and compression contract is documented in the
[API reference](#snapshot-caching).

The server reads the built index at startup and keeps an injected version in memory, preserving the
container's read-only root filesystem. Its `status-snapshot` JSON data block escapes `<`, titles are
HTML-escaped, and SVG logo/favicon values are encoded as data images. The frontend uses this data
for its initial render, including history, without an API call. Its escaped `data-etag` attribute
seeds the first conditional poll.

The frontend makes one `GET /api/status` per refresh, every 45 seconds, with `If-None-Match` once an
ETag is available. A 304 keeps the existing snapshot without a render. Hidden tabs stop polling and
abort pending requests; becoming visible triggers one immediate refresh. Requests time out after 10
seconds. The page shows the snapshot's last-updated time and an "API unreachable" banner on failure,
preserving the last good data and retrying automatically. Development falls back to the same
endpoint when the injected JSON is absent or invalid.

Daily bars include status symbols, date/uptime/degraded labels and a shared visible detail line per
monitor. Tab enters the history; arrow keys, Home and End select days. No-data days are explicitly
labelled and excluded from the uptime average. Colours follow `prefers-color-scheme`; incident text
remains escaped with line breaks. The subscription dialog loads on demand and starts with an empty
email field.

### Measured Overhaul Results

Measurements on the overhaul branch, before and after the frontend slimming commit:

| Metric                       | Before frontend slimming | After frontend slimming                             |
| ---------------------------- | ------------------------ | --------------------------------------------------- |
| Total JavaScript, gzip bytes | 115,695                  | 50,988 (50,012 entry + 976 lazy subscription chunk) |

The polling and in-memory API behavior above are verified by the branch's tests. These are branch
build measurements and implementation/test results; production latency and load testing are separate
deployment checks. `npm run buildall` enforces total JavaScript below 70,000 gzip bytes, including
lazy chunks. `npm run size --prefix frontend-vite` repeats the measurement using Node's `gzipSync`
defaults.

### Preflight Checks

Build the server with `npm run build` (also included in `npm run buildall`) before using the CLI:

```sh
node dist/cli.js check-config [config-path]
node dist/cli.js check-monitors [config-path]
```

The optional path takes precedence over `CONFIG_PATH`, then the usual `.yaml`/`.yml` defaults.
`npm run check-config -- [config-path]` and `npm run check-monitors -- [config-path]` are aliases.
Invalid configuration exits 1. Monitor checks run each HTTP monitor once with the normal timeout,
redirect and body safeguards, print id/name/status/elapsed (milliseconds), and exit 1 if any is
down. They use an isolated in-memory database and do not send notifications or change deployment
data. `npm test` compiles the server first so CLI tests exercise the actual `dist/cli.js` process.

## Roadmap

The following are **not implemented**:

- Manual incident creation and maintenance windows.
- An administration UI.
- Multi-region probes and high availability.
- Slack/webhook and other notification providers.
- An optional PostgreSQL storage backend.
- Ping monitors and optional latency/metric graphs.

## License

This project is released under the MIT License.
