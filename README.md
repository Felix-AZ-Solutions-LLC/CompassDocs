<div align="center">

# 🧭 CompassDocs

**The open-source, self-hosted team knowledge base.**

Write, organize, and search SOPs, technical docs, and policies — with AI answers
grounded in your own documents, a people directory, policy handbooks, and an
approval workflow. Enterprise adds an internal helpdesk, compliance, and SSO.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-orange)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Felix-AZ-Solutions-LLC/CompassDocs)](https://github.com/Felix-AZ-Solutions-LLC/CompassDocs/releases)
[![Docker image](https://img.shields.io/badge/ghcr.io-mattny20%2Fcompassdocs-blue?logo=docker)](https://github.com/users/mattny20/packages/container/package/compassdocs)
![Next.js](https://img.shields.io/badge/Next.js-15-black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue)

[Website](https://compassdocs.io) · [Documentation](https://docs.compassdocs.io) · [Features](https://compassdocs.io/features) · [Pricing](https://compassdocs.io/pricing) · [Quick start](#self-hosting-one-command)

<img src="https://compassdocs.io/img/dashboard.webp" alt="The CompassDocs dashboard: organization announcements, spaces, and recently updated documents" width="800">

</div>

## Why CompassDocs

Team knowledge shouldn't be a scavenger hunt across wikis, drives, and chat
scrollback. CompassDocs is one clean, self-hosted place for it — free and
open-source (AGPL-3.0), running from a single Docker command, with no per-seat
pricing on the core product, ever.

## Features

**Find & ask**
- **Ask CompassDocs** — plain-English questions answered from your docs with inline citations, plus "who does X?" answers straight from the people directory. Powered by a lightweight RAG pipeline over PostgreSQL full-text search; works keyword-only without an API key.
- **Instant search** — ranked, keyword-highlighted results with a ⌘K quick-search everywhere. Drafts stay hidden from viewers.

**Write**
- **Rich editor or Markdown** — headings, tables, checklists, code blocks; paste screenshots inline, size them, add alt text. AI proofreading built in.
- **Rich blocks** — Mermaid & PlantUML diagrams, tabs, accordions, callouts, video & website embeds, interactive checklists, guided decision trees, and auto-filterable tables — all from plain Markdown.
- **Full version history** — side-by-side or inline diffs between any two versions with word-level highlights, one-click restore (approval-aware), and change notes on every save.
- **Draft branches** — edit a private working copy of a live document, then merge it back through the approval workflow. Branches stay out of search and listings.
- **Drafts, tags, attachments,** and one-click **Print / Save as PDF**. Readers pick their page width.

**Organize**
- **Spaces** with three visibility tiers — internal, **private** (granted groups only), or **public** (a branded, read-only site for the open internet, off by default).
- **Per-space edit rights** — restrict who can author in a space, per person or group, with an org-wide override switch.
- **Policy handbooks** — bring published policies and SOPs from any space into one numbered handbook with an introduction; read it as one, keep a policy "handbook only", and print a paper copy with an acknowledgment page.
- **People directory** — profiles, custom fields, assistants, and each person's authored docs; clickable article bylines.
- **Personal dashboard** — what needs your attention, the latest in the spaces you follow, popular this week, your quick links, your team from the directory, new starters and anniversaries, and your open training; show or hide any tile.
- **Quick links** — a launchpad of categorized shortcuts to your other tools, group-restricted, with auto-fetched icons. Pin your own on the dashboard, see your most used, feature links for everyone, and put chosen links on the sign-in page.

**Communicate**
- **Announcements** — org-wide dashboard alerts (info/warning/critical) with a sidebar unread badge, optional email and chat delivery.
- **Newsletter** — branded HTML email written in the doc editor, sent to everyone or selected groups.
- **Subscriptions** — anyone can follow a space and get an email when its docs change; admins can auto-subscribe groups.
- **Notifications** — Webex, Microsoft Teams, Slack, email, or any webhook on review/publish/announcement events. Workspace policies set each event's default per channel (locked on, locked off, or person chooses); everyone gets a personal matrix with quiet hours, a pause, and hourly or daily email digests.
- **Email templates in parts** — every email is a header, a body, a signature, and a footer, with a branded Standard header and footer on by default; preview at desktop or phone width, or send yourself a test.

**Govern**
- **Roles & approval workflow** — Viewer/Editor/Approver/Admin, with a review queue for changes to live docs (strict mode) or direct publishing (open mode), plus suggestions from any reader.
- **Security** — authenticator-app 2FA with recovery codes, per-device sessions, idle timeout, login throttling with lockout, security headers, and a full audit log.
- **Encryption at rest** — credentials (SMTP, AI key, SSO secret, backup creds) sealed with AES-256-GCM under a master key that never touches the database; session tokens stored hashed; backups encrypted before they reach disk or a bucket.
- **Trash & retention**, import/export as front-matter Markdown, scheduled **encrypted** backups with off-site mirroring (S3/R2/MinIO/Azure).

**Measure**
- **Knowledge-base analytics** — views, unique readers, time-on-doc, trending / most / least viewed, search analytics with content gaps (searches that found nothing), reader engagement, author reach, and download counts — filterable by range, space, category, author, and tag, with per-document drill-downs.

**Administer & integrate**
- **Your brand** — fetch your website's icon or upload a logo, pick an accent color, and the whole app re-tints (light/dark/auto).
- **Groups** — manual or synced from Microsoft Entra ID (enterprise); **custom domain with automatic HTTPS**; a system console with storage and resource usage.
- **Claude connector (MCP)** — connect the Claude app with one click and draft, search, and revise docs from Claude; approvals still apply. Claude can also read the handbooks you can read, tell you where you stand, and build draft handbooks and training decks — it never publishes a handbook or confirms a policy for you.

**Enterprise** *(separate licensed build — [pricing](https://compassdocs.io/pricing): $499.99/yr, unlimited users, Helpdesk with 3 agents included, extra agents $125/yr each)*
- **Helpdesk** — employees ask in **Get help** inside CompassDocs; IT, HR, and Facilities work tickets in the **desk**, which installs as an app with push notifications. Workflows across teams with approvals, tasks, and hand-offs; office hours, holidays, and reply targets per team; assignment rules and on-call rotas; tickets from email, monitoring alerts, and API bots; contact cards from the directory; and dashboards you build.
- **Read confirmations & compliance** — who must confirm each policy, due dates, automatic reminders and escalation, typed signatures, whole-handbook confirmation, a compliance portal, team views for leads, and tamper-evident snapshots and audit packages.
- **Training & onboarding** — turn any doc into a slide deck with quizzes, assign it, bundle onboarding programs for new hires, and keep completion records.
- **SSO** (SAML 2.0 and OIDC, one-click Microsoft Entra setup) · **SCIM provisioning** (Entra creates, updates, and deactivates accounts automatically) · **Microsoft 365 directory & group sync** · **audit-log export** · optional dedicated support.
- Licenses are offline, cryptographically signed keys — no phone-home, air-gap friendly. The Community edition is complete on its own.

## Screenshots

| | |
| --- | --- |
| ![AI answer with citations](https://compassdocs.io/img/ai.webp) | ![A rendered SOP document](https://compassdocs.io/img/document.webp) |
| *Ask CompassDocs — cited answers* | *Documents — rich rendering, print to PDF* |
| ![The people directory](https://compassdocs.io/img/directory.webp) | ![The anonymous public site](https://compassdocs.io/img/public-site.webp) |
| *People directory* | *Optional public site* |
| ![The helpdesk desk](https://compassdocs.io/img/helpdesk-desk.webp) | ![A helpdesk workflow across teams](https://compassdocs.io/img/helpdesk-workflow.webp) |
| *Helpdesk — the desk (Enterprise)* | *Helpdesk — workflows across teams* |

## Roles & permissions

| Action | Viewer | Editor | Approver | Admin |
| --- | :--: | :--: | :--: | :--: |
| Read / search / ask AI | ✓ | ✓ | ✓ | ✓ |
| Submit a suggestion | ✓ | ✓ | ✓ | ✓ |
| Create & edit drafts | – | ✓ | ✓ | ✓ |
| Publish / push a change live | – | –¹ | ✓ | ✓ |
| Review queue (approve edits & suggestions) | – | – | ✓ | ✓ |
| Manage users, roles & settings | – | – | – | ✓ |

¹ In **open** approval mode, Editors can publish and edit live docs directly. In **strict** mode (the default) those changes become pending change requests for an Approver.

The four roles are presets: build custom roles from around 200 individual permissions and grant them to a person or a group, workspace-wide or in one space. Enterprise adds built-in **Helpdesk agent** and **Helpdesk manager** roles.

## First-run setup

The first time you open a fresh install, CompassDocs shows a **setup wizard** at
`/setup` where you create your **admin account** (and optionally set your company
name) right in the browser — no default password to look up. From **Admin →
Users** you then add everyone else and assign roles.

Prefer to provision headlessly (CI, automation)? Set `COMPASSDOCS_ADMIN_USER`
and `COMPASSDOCS_ADMIN_PASSWORD` (see `.env.example`) and the admin is created on
first launch instead, skipping the wizard.

> **Authentication** uses local accounts (username + password hashed with Node's `scrypt`) and secure HTTP-only cookie sessions — no external services required. Authenticator-app **2FA** is available to every user. Single sign-on (SAML 2.0 and OIDC, with one-click Microsoft Entra setup) ships in the Enterprise build.

## Tech stack

| Layer     | Choice                                                        |
| --------- | ------------------------------------------------------------- |
| Framework | Next.js 15 (App Router, React 19, TypeScript)                 |
| Styling   | Tailwind CSS                                                  |
| Storage   | PostgreSQL via `pg`, native full-text search (`tsvector`/GIN) |
| Rendering | `react-markdown` + `remark-gfm`                               |
| AI        | Anthropic SDK (`claude-opus-4-8`) with keyword fallback       |

## Getting started

You need **Node.js 20+** and a **PostgreSQL** database. Two easy ways to get a
local Postgres:

**Option A — Docker (recommended).** A `docker-compose.yml` is included:

```bash
docker compose up -d
# DATABASE_URL=postgres://compass:compass@localhost:5432/compassdocs
```

**Option B — Homebrew (no Docker):**

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb compassdocs
# DATABASE_URL=postgres://localhost:5432/compassdocs
```

Then run the app:

```bash
npm install
cp .env.example .env        # set DATABASE_URL to the value from above
npm run dev
# open http://localhost:3000
```

On first connection the app **creates its own schema and seeds** four spaces and
nine example documents — no manual migrations to run. Schema creation is
idempotent and guarded by a Postgres advisory lock, so it's safe across
concurrent startups (e.g. serverless cold starts). Sign in with `admin` / `admin`.

### Production build

```bash
npm run build
npm run start
```

## AI-powered search (optional)

Search and answers work out of the box **without any API key** — the "Ask
CompassDocs" page falls back to returning the best-matching document snippets.

To enable synthesized, cited AI answers, set in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# optional override:
# COMPASSDOCS_AI_MODEL=claude-opus-5-5
```

The AI answer flow is a lightweight RAG pipeline: the question is used to
retrieve the top documents via Postgres full-text search, those excerpts are
passed to Claude as grounded context, and the model is instructed to answer only
from them and cite sources. Any API error degrades gracefully to the keyword
fallback.

## Deploy to Azure (one click)

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FFelix-AZ-Solutions-LLC%2FCompassDocs%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2FFelix-AZ-Solutions-LLC%2FCompassDocs%2Fmain%2Fdeploy%2Fazure%2FcreateUiDefinition.json)

Launches the full stack (app + Postgres, optional HTTPS proxy) on an Ubuntu VM
through a guided portal wizard: pick any VM size, create or join an existing
virtual network, restrict SSH/web access by CIDR, choose disk types and an
optional dedicated data disk, and set the CompassDocs edition, license, and
admin bootstrap — all before clicking Create. Details in
[deploy/azure](deploy/azure/).

## Self-hosting (one command)

The easiest way to run CompassDocs is with Docker — it starts the app **and** a
Postgres database together. On a machine with [Docker](https://docs.docker.com/get-docker/)
installed:

```bash
curl -fsSL https://raw.githubusercontent.com/Felix-AZ-Solutions-LLC/CompassDocs/main/install.sh | bash
```

This creates a `./compassdocs` folder, generates strong random passwords, starts
everything, and prints your admin login. Open **http://localhost:3000**.

**Update to the latest release** — from that folder:

```bash
docker compose pull && docker compose up -d
```

Your data lives in a Docker volume and is preserved across updates; the app
migrates its own schema on start, so there are no manual upgrade steps. (Re-running
the install command does the same thing.)

Prefer to do it by hand? Grab [`deploy/docker-compose.yml`](./deploy/docker-compose.yml)
and [`deploy/.env.example`](./deploy/.env.example), fill in the `.env`, and run
`docker compose up -d`.

**Build from source instead of pulling an image** — for local development or a
private fork, [`docker-compose.local.yml`](./docker-compose.local.yml) builds the
app from this repo and runs it with Postgres, so no registry or auth is needed:

```bash
docker compose -f docker-compose.local.yml up -d --build   # http://localhost:3000
```

### Custom domain & HTTPS

To serve CompassDocs on your own domain with automatic HTTPS, use the Caddy
reverse-proxy stack ([`deploy/docker-compose.tls.yml`](./deploy/docker-compose.tls.yml)
+ [`deploy/Caddyfile`](./deploy/Caddyfile)):

1. Point your domain's DNS (an `A`/`AAAA` record) at the server, and make sure
   ports **80** and **443** are reachable.
2. In `.env`, set `COMPASSDOCS_DOMAIN=docs.example.com` (plus `POSTGRES_PASSWORD`).
3. Start it:
   ```bash
   docker compose -f docker-compose.tls.yml up -d
   ```

Caddy obtains and renews a **Let's Encrypt** certificate automatically; the app
isn't exposed on the host directly — all traffic flows through Caddy on 80/443.
The `Caddyfile` also documents two alternatives you can switch to with one line:
**self-signed** (`tls internal`, for a LAN or testing) or **bring-your-own
certificate** (drop `cert.pem`/`key.pem` in `deploy/certs`).

> Images are published to `ghcr.io/mattny20/compassdocs` automatically on every
> merge to `main` (`:latest`) by the
> [Docker publish workflow](./.github/workflows/docker-publish.yml), and each
> release adds its version tag (`:X.Y.Z`). The project
> has moved to the Felix-AZ-Solutions-LLC organization, so every image is also
> published to `ghcr.io/felix-az-solutions-llc/compassdocs`; installs switch to
> that address in a later release.

## Deploying to a platform (Vercel / Railway / Render)

CompassDocs is a standard Next.js server plus a Postgres database — the app is
stateless, so it runs anywhere and scales horizontally. Set `DATABASE_URL` (and
optionally `ANTHROPIC_API_KEY`, `COMPASSDOCS_ADMIN_*`) as environment variables.

| Target | How |
| --- | --- |
| **Vercel + Neon** | Import the repo on Vercel; add a Neon (or Vercel Postgres) database and set `DATABASE_URL`. Cheapest to start; Vercel's free tier is non-commercial. |
| **Railway** | One project with the app **and** a Postgres plugin. Railway injects `DATABASE_URL`. Commercial-friendly, ~$5/mo. |
| **Render** | Web Service from the repo + a managed Postgres instance; wire its internal `DATABASE_URL` to the service. |
| **Docker (Fly.io, a VPS, anywhere)** | A `Dockerfile` is included (Next.js standalone output). `docker build -t compassdocs . && docker run -p 3000:3000 -e DATABASE_URL=... compassdocs`. |

Use a managed Postgres with connection pooling (Neon and Supabase provide a
pooled connection string) when deploying to serverless platforms, and keep
`DATABASE_POOL_MAX` modest.

### Health checks and graceful shutdown

| Path | Probe | Answers |
| --- | --- | --- |
| `/healthz` | liveness and startup | 200 while the process serves requests. Never touches the database, so a database outage never restarts a healthy process. |
| `/readyz` | readiness | 200 `{"status":"ready","migrations":"applied"}` once the schema and its migrations are applied and the database answers within 3 s; 503 with the reason otherwise (`migrations in progress`, `migrations could not run`, `database unreachable`; after a failed migration it reports that failure with a `retry_at` instead of starting the migrations again on every probe), and 503 `{"status":"draining"}` from the moment the process is told to stop. With `COMPASSDOCS_FILE_STORE=blob`, also 503 `file storage unreachable` until the workspace's container has answered once ([File storage](#file-storage)). It never waits for the database (1.21.2). |

The image starts the app with `node start.cjs` (since 1.21.0). On `SIGTERM`
(what `docker stop`, Kubernetes and Azure Container Apps send) it stops
accepting connections, lets the requests in flight finish, stops the
schedulers, ends the helpdesk's live streams (browsers reconnect; new ones
get 503 until the process exits), waits for background jobs that are running
(a newsletter going out through Microsoft 365 stops between two sends), closes the database pool and exits `0`,
all within `COMPASSDOCS_SHUTDOWN_TIMEOUT` seconds (default `25`, under the
30 s most platforms wait before killing). Past it, open connections are cut,
the log says what was still running, and the exit code is `1`. A `SIGTERM`
that comes while the server is still starting stops it at once. Running
`node server.js` directly still works, without these steps.

## Cloud mode (COMPASSDOCS_CLOUD)

`COMPASSDOCS_CLOUD=1` runs CompassDocs as a CompassDocs Cloud workspace: an
Azure Container App managed from the CompassDocs console, its secrets in
Azure Key Vault. A self-hosted install never sets it, and nothing below
applies to one.

**What cloud mode hides.** Everything that manages hosting or installs
software belongs to the platform. Each is gone from the settings rail, its
search and the command palette; a page reached by an old link shows
"Managed by CompassDocs Cloud"; and its API answers `403` with
`{"code":"cloud_managed","error":"<Area> is managed by CompassDocs Cloud, so it can't be changed here."}`.

| Area | In the app | APIs refused (403) |
| --- | --- | --- |
| Domain & HTTPS (custom domain, TLS mode and certificates, the bundled Caddy, fallback hosts, the session-cookie setting) | Settings → Domain & HTTPS; the setup wizard's domain, HTTPS and cookie choices; the Diagnostics card's "Open Domain & HTTPS" | `GET/PATCH /api/admin/domain`, `DELETE /api/admin/domain/fallback`, `POST/DELETE /api/admin/domain/pending`, `GET /.well-known/compassdocs-domain-check/<token>`, and `custom_domain`, `tls_mode`, `tls_email`, `secure_cookies` on `POST /api/setup` |
| Updates (the update check and the one-click updater) | Settings → System → Version & updates | `GET /api/admin/version`, `POST /api/admin/update` |
| Backups (local backups, their schedule, off-site destinations, restore) | Settings → Backups; the backup rows of System → Storage; the palette's Backups command | `GET/POST /api/backups`, `GET/DELETE /api/backups/<name>`, `POST /api/backups/<name>/restore`, `GET/PATCH /api/admin/backup-destinations`, and `backup_frequency`, `backup_keep` on `PATCH /api/admin/settings` |

In the background, cloud mode runs no scheduled backups, no domain
re-checks and pushes nothing to a proxy. The session cookie is always
`Secure`.

**Environment variables.** Container Apps maps each secret to a Key Vault
secret reference.

| Variable | Secret | Cloud mode |
| --- | --- | --- |
| `COMPASSDOCS_CLOUD` | | `1` switches cloud mode on. |
| `COMPASSDOCS_SECRET_KEY` | yes | **Required.** The encryption key for secrets at rest, 32 bytes as 64 hex or 44 base64 characters. Without it (or with a malformed one) the process logs `Cloud mode (COMPASSDOCS_CLOUD=1) can't start: …` and exits 1. No key file is ever created, written or read (not `/uploads/.secret.key`, not `COMPASSDOCS_KEY_FILE`). |
| `DATABASE_URL` | yes | **Required.** The PostgreSQL connection string. With `DATABASE_AUTH=entra`, a `postgres://` URL whose user is the managed identity's PostgreSQL role and which has no password, e.g. `postgres://ws-acme-app@cdcloud-pg.postgres.database.azure.com/ws_acme`. |
| `DATABASE_AUTH` | | `entra` signs in to PostgreSQL with the managed identity's Microsoft Entra token: no database password exists anywhere (see [Signing in to PostgreSQL with Microsoft Entra](#signing-in-to-postgresql-with-microsoft-entra)). Unset (or `password`): `DATABASE_URL` and `DATABASE_PASSWORD` as before. Works self-hosted too. |
| `DATABASE_SSL` | | With `DATABASE_AUTH=entra`, SSL is always on and the server's certificate is verified; `no-verify` keeps the encryption and skips the check. `disable` is refused. |
| `DATABASE_PASSWORD` | yes | Optional: the database password kept apart from `DATABASE_URL` (it replaces any password in the URL, and in `DATABASE_LISTEN_URL`). Works self-hosted too. Refused with `DATABASE_AUTH=entra`. |
| `DATABASE_LISTEN_URL` | yes | Optional: a direct connection for the helpdesk's live updates when `DATABASE_URL` is a transaction-mode pooler. |
| `COMPASSDOCS_BASE_URL` | | **Required.** The workspace's public address, e.g. `https://acme.compassdocs.io`. Every link in email, the portal's sign-in links and OAuth redirects are built from it (a custom domain saved earlier is ignored). Missing, not a valid URL or not `https://`, the process logs `Cloud mode (COMPASSDOCS_CLOUD=1) can't start: COMPASSDOCS_BASE_URL …` and exits 1 (a plain-http loopback address, such as `http://localhost:3000` on a developer's machine, only logs a warning). Self-hosted, it stays optional. |
| `COMPASSDOCS_LICENSE_KEY` | yes | When set, the platform's license: it wins over a saved key, and Settings → License shows it read-only, "Managed by CompassDocs Cloud". With `COMPASSDOCS_LICENSE_URL`, it is the bootstrap: the license the workspace starts with until the console's arrives. |
| `COMPASSDOCS_LICENSE_URL` | | Optional: the console's license endpoint for this workspace. The app fetches the workspace's license from it shortly after start and about every 6 hours, so a renewal needs no restart (see [License from the console](#license-from-the-console)). Must be `https://`. Needs `COMPASSDOCS_WORKSPACE_ID` and one of the two below; without them cloud mode doesn't start. |
| `COMPASSDOCS_LICENSE_AUDIENCE` | | With `COMPASSDOCS_LICENSE_URL` (**recommended**): the console's app ID URI, e.g. `api://compassdocs-console`. The app asks for a Microsoft Entra token for `<audience>/.default` as its managed identity: no secret to store or rotate. Wins over `COMPASSDOCS_LICENSE_TOKEN`. |
| `COMPASSDOCS_LICENSE_TOKEN` | yes | With `COMPASSDOCS_LICENSE_URL`, when the managed identity isn't used: a bearer token the console issued to this workspace. |
| `COMPASSDOCS_USAGE_URL` | | Optional (1.22.0): where a workspace with a Cloud plan sends its daily usage (see [Usage to the console](#usage-to-the-console)). Unset, `COMPASSDOCS_LICENSE_URL` with its last path segment replaced by `usage`. Must be `https://` on the license URL's origin, since it is sent with the same credential; otherwise cloud mode doesn't start. |
| `ANTHROPIC_API_KEY` | yes | When set, the platform's AI key: it wins over a saved key and Settings → AI shows it read-only. |
| `COMPASSDOCS_SMTP_HOST`, `COMPASSDOCS_SMTP_PORT` (587), `COMPASSDOCS_SMTP_SECURE` (`starttls`, `tls` or `none`), `COMPASSDOCS_SMTP_USER`, `COMPASSDOCS_SMTP_PASSWORD` (secret), `COMPASSDOCS_SMTP_FROM` | password | When `COMPASSDOCS_SMTP_HOST` is set, the platform's mail relay: Settings → Email shows SMTP read-only, and the workspace can still choose Microsoft 365 instead. Read only in cloud mode. |
| `COMPASSDOCS_MAIL_TRANSPORT` | | `acs` sends the workspace's email through [Azure Communication Services](#email-through-azure-communication-services), CompassDocs Cloud's way: it wins over SMTP and Microsoft 365 (Settings → Email shows "Email is sent by CompassDocs Cloud"). Unset: as chosen in Settings. Any other value: the process exits 1. Works self-hosted too. |
| `COMPASSDOCS_ACS_ENDPOINT` | | With `acs`: the Communication Services resource, e.g. `https://cdcloud-mail.communication.azure.com` (`https://`, no path, no key). The app signs in with the managed identity. |
| `COMPASSDOCS_ACS_SENDER` | | With `acs`: the MailFrom address this workspace's email leaves from, on a domain verified in ACS and connected to the resource, e.g. `acme@mail.compassdocs.io`. Its display name is the sender username's, set in Azure. |
| `COMPASSDOCS_ACS_REPLY_TO` | | Optional: where replies go while the workspace hasn't set its own reply address in Settings → Email. |
| `COMPASSDOCS_ACS_PER_MINUTE`, `COMPASSDOCS_ACS_PER_HOUR` | | This workspace's share of the subscription's ACS sending quota (default `30` and `100`, ACS's defaults for a custom domain). |
| `COMPASSDOCS_ACS_CONNECTION_STRING` | yes | Development only: `endpoint=…;accesskey=…`. Cloud mode refuses one whose endpoint is not a loopback address. Masked in every log line. |
| `COMPASSDOCS_SETUP_TOKEN` | yes | The first-run setup token the platform hands the customer. Cloud mode never prints a setup token to the log. |
| `COMPASSDOCS_ADMIN_USER`, `COMPASSDOCS_ADMIN_PASSWORD` | password | Optional: create the first administrator without the setup page. |
| `COMPASSDOCS_METRICS_TOKEN` | yes | Optional: a bearer token for `/metrics`. |
| `COMPASSDOCS_FILE_STORE` | | `blob` keeps the workspace's files in Azure Blob Storage (see [File storage](#file-storage)). Unset, files stay in `COMPASSDOCS_UPLOAD_DIR`, which must then be a persistent volume every replica shares (cloud mode logs a warning). |
| `COMPASSDOCS_BLOB_ACCOUNT_URL` | | With `blob`: the storage account's address, e.g. `https://cdcloud.blob.core.windows.net` (no SAS, no path). The app signs in with the container app's managed identity. |
| `COMPASSDOCS_BLOB_CONTAINER` | | With `blob`: the workspace's own container, e.g. `ws-acme`. |
| `AZURE_CLIENT_ID` | | Optional: the client id of the user-assigned managed identity to sign in with (unset: the system-assigned one). One identity for everything the app signs in to: Blob Storage, PostgreSQL (`DATABASE_AUTH=entra`), the console's license endpoint (`COMPASSDOCS_LICENSE_AUDIENCE`) and Azure Communication Services (`COMPASSDOCS_MAIL_TRANSPORT=acs`). |
| `COMPASSDOCS_BLOB_CONNECTION_STRING` | yes | Development only (Azurite). Cloud mode refuses one that is not a loopback address. |
| `DATABASE_RETRY_WINDOW_MS` | | How long a request waits for the database through a restart or failover (default `60000` in cloud mode; see [Riding out a database restart](#riding-out-a-database-restart)). |
| `COMPASSDOCS_UPLOAD_DIR` | | Where attachments live without `COMPASSDOCS_FILE_STORE=blob`: a persistent mount (Azure Files). |
| `COMPASSDOCS_LOG_FORMAT` | | Cloud mode logs JSON; `text` switches back to readable lines, redacted the same way. |
| `COMPASSDOCS_SHUTDOWN_TIMEOUT` | | Seconds to drain on `SIGTERM` (default 25). |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | yes | Optional: traces and metrics to the workspace's Application Insights. See [Telemetry](#telemetry-opentelemetry). |
| `COMPASSDOCS_WORKSPACE_ID` | | The workspace's id, set by the console. Required with `COMPASSDOCS_LICENSE_URL` and `COMPASSDOCS_SUPPORT_PUBLIC_KEY`: a license from the console, and a support token, is used only when it names this id. With telemetry on, every span and metric carries it as `compassdocs.workspace.id`. |
| `COMPASSDOCS_SUPPORT_PUBLIC_KEY` | | Optional: switches on [support access](#support-access). The public half of the console signing service's Ed25519 support key, as base64 (SubjectPublicKeyInfo, `MCowBQYDK2VwAyEA…`) or PEM; up to three, comma-separated, while the signing key is rotated. Never the license key (refused). Not a valid Ed25519 key, the license key, more than three, or set without `COMPASSDOCS_WORKSPACE_ID`: the process logs `Cloud mode (COMPASSDOCS_CLOUD=1) can't start: COMPASSDOCS_SUPPORT_PUBLIC_KEY …` and exits 1. Read only in cloud mode. |

The workspace's own integration secrets (its Microsoft 365, Slack, Teams,
single sign-on, SCIM, Duo, directory and helpdesk connections, an
OpenAI-compatible endpoint) are not platform secrets: the workspace admin
keeps setting them in Settings, and they stay encrypted in the database with
`COMPASSDOCS_SECRET_KEY`.

**Probes.** Point the Container App's probes at the paths in
[Health checks and graceful shutdown](#health-checks-and-graceful-shutdown):
startup `GET /healthz` (allow a fresh database a minute or two for its
first migrations), liveness `GET /healthz`, readiness `GET /readyz` (a
timeout of at least 5 s; the app answers within 3).

**Logs.** In cloud mode (or with `COMPASSDOCS_LOG_FORMAT=json` anywhere)
every line on stdout and stderr is one JSON object:
`{"time","level","message","event","request_id",…,"ts"}`. `request_id` is
the request's `x-request-id` (the platform's own, or one the app gives each
request and sends back in the response), on lines written while serving
it. With [telemetry](#telemetry-opentelemetry) on, a line written inside a
traced request or job also has `trace_id` and `span_id`. Secrets never appear: the values of the secret variables above, passwords
in connection strings, bearer tokens, JWTs (an Entra access token), API keys, ACS access keys and request signatures, and fields named like a secret
are written as `[redacted]`. (`ts` repeats `time` for parsers of the
pre-1.21.0 JSON lines.)

### File storage

Every attachment, image, logo, newsletter file and helpdesk upload is kept
under an opaque random name (the original filename stays in the database),
in one of two stores:

- **The uploads folder** (the default, and what every self-hosted install
  keeps using unless it opts in): `COMPASSDOCS_UPLOAD_DIR`, `/uploads` in
  the image. Nothing about it changed in 1.21.2: the same paths and files.
- **Azure Blob Storage** (`COMPASSDOCS_FILE_STORE=blob`): one private
  container per workspace, `COMPASSDOCS_BLOB_CONTAINER` in the account at
  `COMPASSDOCS_BLOB_ACCOUNT_URL`. CompassDocs Cloud keeps each workspace's
  container in a shared zone-redundant (GZRS) account.

| Variable | Default | |
| --- | --- | --- |
| `COMPASSDOCS_FILE_STORE` | `local` | `blob` for Azure Blob Storage. |
| `COMPASSDOCS_BLOB_ACCOUNT_URL` | | `https://<account>.blob.core.windows.net`: the bare address, never a SAS. |
| `COMPASSDOCS_BLOB_CONTAINER` | | The workspace's container (3–63 lower-case letters, digits and hyphens). It must exist: the app never creates one. |
| `AZURE_CLIENT_ID` | | A user-assigned managed identity's client id. With `AZURE_FEDERATED_TOKEN_FILE` and `AZURE_TENANT_ID` too, workload identity (AKS). |
| `COMPASSDOCS_BLOB_CONNECTION_STRING` | | Instead of the account URL, for development against [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) only (a real account's key works self-hosted with a warning; cloud mode refuses it). Masked in every log line. |

**Signing in.** In production the app uses Microsoft Entra ID, never a
key: the container app's managed identity (or workload identity), which
needs the **Storage Blob Data Contributor** role on the workspace's
container. No account key or SAS is read, logged or made, and no URL to a
file is ever handed out: files are only served through the app's own
authorised routes (attachments, video with byte ranges, the portal, the
help centre), with the same content types and download behaviour as
before. The Azure SDK is loaded only in blob mode. In blob mode the uploads
folder holds no user file; a self-hosted install that opts in keeps its
master key file there as before (or uses `COMPASSDOCS_SECRET_KEY`).

**Start-up and readiness.** A missing or invalid setting is one error line
each (`File storage can't start: …`) and the process exits 1. Then the
container is tried once: if it is missing, the identity may not use it, or
it does not answer, that is one error line, and `/readyz` answers 503
`file storage unreachable` until the container answers, so a revision with
broken storage never takes traffic. Once it has answered, `/readyz` does not
check it again: storage is shared by every replica, so a blip there would
take them all out of rotation, including for pages that need no file.
Settings → System → Diagnostics' "Upload storage" check writes and removes a
probe blob.

**Usage.** `storedUsage()` in `lib/uploads` gives the workspace's files and
bytes (in blob mode every blob in its container), with one listing call per
5000 files.

**Backups.** A backup set's files half is made from whichever store is in
use and restores into whichever store is in use: an uploads-folder backup
restores into a container (its stored files; anything else the folder held
is skipped and counted) and the other way round. Restoring adds or replaces
files and never deletes one.

**Moving an existing install into a container.** `copy-uploads-to-blob.cjs`
(in the image's `/app`; `scripts/` in the repository) copies the uploads
folder's stored files into the container. It is idempotent and resumable: a
file already in the container with the same size and MD5 is left alone, so
a run that stopped is simply run again; a blob with different content is a
conflict, never overwritten. Each copied file is read back and checked. The
master key file and anything that is not a stored file are listed and
skipped, and the folder is never changed. It signs in with
`DefaultAzureCredential` (an operator's `az login`, a service principal in
`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`, or a managed
identity):

```bash
# UPLOADS_VOLUME: the install's uploads volume (`docker volume ls | grep uploads`).
docker run --rm -v "$UPLOADS_VOLUME":/uploads:ro \
  -e AZURE_TENANT_ID -e AZURE_CLIENT_ID -e AZURE_CLIENT_SECRET \
  ghcr.io/mattny20/compassdocs:1.21.2 \
  node copy-uploads-to-blob.cjs --from /uploads \
    --account-url https://cdcloud.blob.core.windows.net --container ws-acme
# --dry-run lists what it would copy; --json prints a summary object; exit 0 = everything is there.
```

Run it once with the old install still serving, again after stopping it (it
only copies what changed), then start the workspace with
`COMPASSDOCS_FILE_STORE=blob`. Cloud mode takes the encryption key from
`COMPASSDOCS_SECRET_KEY`, never the key file: set it to the contents of the
old `/uploads/.secret.key` (see below), or saved credentials and backups
can't be opened.

### Email through Azure Communication Services

With `COMPASSDOCS_MAIL_TRANSPORT=acs` the workspace's email (notifications,
reminders, digests, sign-in links, newsletters, helpdesk replies) goes out
through [Azure Communication Services Email](https://learn.microsoft.com/azure/communication-services/concepts/email/email-overview)
instead of SMTP or Microsoft 365. It is the operator's choice, not the
workspace's: Settings → Notifications → Email says "Email is sent by
CompassDocs Cloud from …" (in cloud mode; "…through Azure Communication
Services…" on a self-hosted install that opts in), the SMTP and Microsoft
365 settings stay stored but are not used, and switching is refused. What
stays the workspace's is **Replies go to**: the sender takes no replies, so
an email that names no reply address of its own gets this one (a helpdesk
reply keeps its help address, a newsletter its chosen sender). Self-hosted
installs that don't set the variable are unchanged.

**How it sends.** Every message is built exactly as before and queued in
the [outbox](#how-it-fits-together) (sealed, with retries, Retry and
Discard), then posted to `POST {endpoint}/emails:send?api-version=2023-03-31`
with an `Operation-Id` of its own. ACS answers 202 and delivers later, so
the row is *accepted* and its operation is looked up shortly after
(`GET {endpoint}/emails/operations/{id}`): **Succeeded** → sent, **Failed**
or **Canceled** → failed with ACS's reason (a suppressed or invalid
recipient, say), still unknown after two hours → *may not have gone out*,
for an admin. A send whose answer never came is looked up by its
`Operation-Id` before anyone is asked. A 429 pauses the whole outbox for
its `Retry-After` (at least a minute) and fails nothing. The outbox paces
itself to `COMPASSDOCS_ACS_PER_MINUTE` and `COMPASSDOCS_ACS_PER_HOUR`.

| | Through ACS |
| --- | --- |
| From | `COMPASSDOCS_ACS_SENDER`, always; the display name is the sender username's (Azure), the API has no field for it |
| Reply-To | the message's own; else its From, when that is another address; else the workspace's reply address; else `COMPASSDOCS_ACS_REPLY_TO` |
| Body | plain text and HTML, as built |
| Attachments | up to 10 MB per email *after* base64 (about 7.5 MB of files); a larger one is refused when it is queued, in words. ACS accepts [these types](https://learn.microsoft.com/azure/communication-services/concepts/email/email-attachment-allowed-mime-types) |
| Recipients | at most 50 per email (To, Cc and Bcc together) |
| Headers | `Message-ID`, `In-Reply-To`, `References` (helpdesk threading), `List-Unsubscribe`, `List-Unsubscribe-Post`, `Auto-Submitted` and the rest are passed through `headers` |
| Tracking | open and click tracking is switched off on every message (`userEngagementTrackingDisabled`) |

The app calls the REST API directly (two calls) rather than
`@azure/communication-email`: no new dependency, nothing more in the image,
and the outbox keeps control of retries, 429s and how often a result is
looked up (ACS limits status lookups too: 60 a minute, 200 an hour per
subscription). It signs in with the same managed identity as Blob Storage
and PostgreSQL (a Microsoft Entra token for
`https://communication.azure.com/.default`, `@azure/identity` loaded only
when first needed).

**Azure setup.**

1. Create an **Email Communication Services** resource and add a
   **custom domain** (for example `mail.compassdocs.io`); add the TXT, SPF,
   DKIM and DKIM2 records it shows (and DMARC) until the domain is
   **Verified**. An Azure-managed `*.azurecomm.net` domain is for testing
   only: 5 emails a minute, and its sender can't be renamed.
2. Under the domain's **MailFrom addresses**, add one sender username per
   workspace (for example `acme`, display name "Acme") and set it as
   `COMPASSDOCS_ACS_SENDER` (`acme@mail.compassdocs.io`). The display name
   set here is what recipients see. Azure enables more sender usernames than
   the default `DoNotReply` only on a domain whose sending limits were
   raised, and allows 100 per domain.
3. Create a **Communication Services** resource, **Connect** the verified
   domain to it (Email → Domains), and set its endpoint as
   `COMPASSDOCS_ACS_ENDPOINT`.
4. Give the workspace's managed identity (the container app's, or the
   user-assigned one in `AZURE_CLIENT_ID`) a role **on the Communication
   Services resource**: the built-in **Communication and Email Service
   Owner**, or a custom role with only
   `Microsoft.Communication/CommunicationServices/Read`,
   `Microsoft.Communication/CommunicationServices/Write` and
   `Microsoft.Communication/EmailServices/write`, the minimal set Microsoft
   documents for sending email with an Entra identity
   ([Microsoft Learn](https://learn.microsoft.com/azure/communication-services/quickstarts/email/send-email-smtp/smtp-authentication#assign-a-role-to-the-microsoft-entra-application)).
   Without it every send is refused (401/403): the outbox pauses with that
   reason and the admins are told once.
5. **Limits.** ACS's defaults for a custom domain are 30 emails a minute
   and 100 an hour **per subscription**, shared by every workspace sending
   from it. Ask for more with a quota request (Azure support, "Azure
   Communication Services Email: Sending Limits"), and give each workspace
   its share in `COMPASSDOCS_ACS_PER_MINUTE` / `COMPASSDOCS_ACS_PER_HOUR`.

**Start-up.** A setting that can't work is one line each (`Email through
Azure Communication Services can't start: …`) and the process exits 1:
no sender, no endpoint, an endpoint that is not `https://` or carries a
key, a limit that is not a whole number, and in cloud mode a connection
string to a real resource. Otherwise one line says the sender, the
resource, how the app signs in and the limits. Nothing is sent at start-up.
Settings → System → Diagnostics' **Run checks** signs in and looks up an
operation that does not exist, sending nothing.

**Development.** `COMPASSDOCS_ACS_CONNECTION_STRING=endpoint=…;accesskey=…`
signs each request with the resource's access key (HMAC-SHA256) instead of
the managed identity. It works self-hosted with a warning; cloud mode
refuses it unless the endpoint is a loopback address (a local mock). The
key is masked in every log line.

**Before you depend on it.** Microsoft has announced that Azure
Communication Services, ACS Email included, retires on **30 September
2028**, with new onboarding limited from 23 October 2026 ([retirement
guide](https://learn.microsoft.com/azure/communication-services/acs-retirement-and-breaking-changes-guide)).
Resources created before then keep working until retirement. The SMTP and
Microsoft 365 transports are unaffected.

### Riding out a database restart

Azure resizes, patches and fails over a PostgreSQL flexible server with a
pause of 10 to 60 seconds. With `DATABASE_RETRY_WINDOW_MS` above 0 (the
default in cloud mode is `60000`; self-hosted it is `0`, as before, unless
you set it) a request that meets such a pause waits for the database, trying
again with backoff (250 ms doubling to 5 s), instead of failing.

- **Retried**: getting a connection (refused, reset, timed out, `57P01`,
  `57P03` "starting up", `53300`, "Connection terminated"), for
  `pool.query()` and for `pool.connect()` before a transaction; and a
  statement pg refused to send because its connection had already failed.
  Nothing has reached the server in either case.
- **Never retried**: a statement that was sent. If the connection drops
  after that, the request fails: the server may already have run and
  committed it. Nor anything inside a transaction: one that breaks midway
  fails and is never resumed or replayed. Authentication errors, a missing
  database and every statement error fail at once, as before.
- A request waits at most the window, and never past the outage's own
  window (one that arrives 50 s into an outage waits 10 s more; after that,
  requests fail at once until the database answers). While shutting down,
  no wait runs past the drain deadline. A request that gave up fails with
  "The database is unavailable (…); waited N s for it."
- A broken connection is closed, never handed out again.
- The log says `db.unavailable` once when an outage starts and `db.available`
  once when it ends (how long, how many requests waited, how many gave up,
  how many background tasks skipped a run). A background job that meets an
  outage skips that run quietly and tries again at its next one. With
  telemetry on, `compassdocs.db.outages` and
  `compassdocs.db.retried_requests` count them. `/readyz` never waits.

### Signing in to PostgreSQL with Microsoft Entra

`DATABASE_AUTH=entra` (1.21.3) signs in to an Azure Database for
PostgreSQL flexible server with the container app's managed identity, so
no database password exists anywhere: not in Key Vault, not in the
environment, not in a URL. Self-hosted installs (and cloud workspaces
without it) are unchanged: `DATABASE_URL` and `DATABASE_PASSWORD` work
exactly as before.

- **How it signs in.** The user in `DATABASE_URL` is the identity's
  PostgreSQL role; the password of each new connection is a Microsoft Entra
  access token for `https://ossrdbms-aad.database.windows.net/.default`,
  for the user-assigned identity named by `AZURE_CLIENT_ID` (or the
  system-assigned one; workload identity when `AZURE_FEDERATED_TOKEN_FILE`,
  `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` are set), the same identity the
  [file store](#file-storage) uses. The token is cached and renewed in the
  background well before it expires (at the earlier of half its life and 30
  minutes before expiry), so every new connection gets a valid one at once,
  and open connections never need one again: PostgreSQL checks it only at
  sign-in. `@azure/identity` loads only in this mode.
- **Every connection**: the pool (every query, the schema boot and its
  migrations), the helpdesk's LISTEN connection (`DATABASE_LISTEN_URL`, or
  `DATABASE_URL`), and `pg_dump`/`pg_restore` for backups (the token goes in
  their environment as `PGPASSWORD`, never their arguments). The image's
  scripts (`start.cjs`, `copy-uploads-to-blob.cjs`) never connect to the
  database.
- **SSL** is required and the server's certificate verified (flexible
  servers chain to DigiCert and Microsoft roots, which Node and the image
  trust; `pg_dump` uses `sslmode=verify-full` with the system roots).
  `DATABASE_SSL=no-verify` encrypts without the check; `sslrootcert=<file>`
  in the URL verifies against your own CA.
- **Start-up.** A setting that can't work is one line,
  `The database sign-in can't start: …`, and exit 1: a password in the URL,
  `DATABASE_PASSWORD` set, SSL turned off, no role in the URL, or a
  key=value connection string. Otherwise one line says how it signs in
  (which identity, which role, whether the certificate is verified).
- **When there is no token.** One line names the identity and the scope
  (`Could not get a Microsoft Entra token for https://ossrdbms-aad.database.windows.net/.default as the user-assigned managed identity <id>: …`),
  never the token. A token service that doesn't answer (network, timeout,
  429, 5xx) while a cached token is still good costs nothing; with none
  left, it counts as the database being unavailable, so requests wait
  through it like a [database restart](#riding-out-a-database-restart). An
  identity that is refused (not assigned to the app, unknown) fails at once:
  waiting won't fix it. Tokens never appear in a log line: JWTs are masked
  wherever they appear.

**The Azure side**, once per server and once per workspace:

1. On the flexible server, turn on Microsoft Entra authentication
   (*Security → Authentication*: "PostgreSQL and Microsoft Entra
   authentication") and add a Microsoft Entra admin there (*Add Microsoft
   Entra Admin*: a group the platform team is in, or the console's own
   identity), or with
   `az postgres flexible-server microsoft-entra-admin create -g <rg> -s <server> -u <admin-group-name> -i <admin-object-id> -t Group`
   (`ad-admin create` on older Azure CLIs).
2. Signed in as that admin (`PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)`),
   connect to the `postgres` database (the function exists only there)
   and create a role for the workspace's managed identity. Its name must
   be the identity's name (a user-assigned identity's resource name, or
   for a system-assigned one the container app's name), and it is the
   user in `DATABASE_URL`:

   ```sql
   SELECT * FROM pgaadauth_create_principal('ws-acme-app', false, false);
   -- or, naming the role yourself and binding it to the identity's object id:
   -- SELECT * FROM pgaadauth_create_principal_with_oid('ws-acme-app', '<principal-object-id>', 'service', false, false);
   ```

3. Give it the workspace's database and nothing else:

   ```sql
   CREATE DATABASE ws_acme OWNER "ws-acme-app";
   REVOKE ALL ON DATABASE ws_acme FROM PUBLIC;
   GRANT CONNECT, TEMPORARY ON DATABASE ws_acme TO "ws-acme-app";
   -- An existing database (moved from password sign-in): hand it and its objects over.
   -- ALTER DATABASE ws_acme OWNER TO "ws-acme-app";
   -- \c ws_acme
   -- REASSIGN OWNED BY old_app_user TO "ws-acme-app";
   ```

   The app creates and migrates its own schema, so it needs to own the
   database (or `CREATE` on it and ownership of its tables).
4. Set `DATABASE_AUTH=entra`, `DATABASE_URL=postgres://ws-acme-app@<server>.postgres.database.azure.com/ws_acme`
   (and `AZURE_CLIENT_ID` for a user-assigned identity); remove
   `DATABASE_PASSWORD` and its Key Vault secret. A user-assigned identity's
   PostgreSQL role must name *that* identity.

### License from the console

In cloud mode, `COMPASSDOCS_LICENSE_URL` (1.21.3) has the app fetch the
workspace's signed license from the CompassDocs console, so a renewal
reaches a running workspace without a restart. `COMPASSDOCS_LICENSE_KEY`
stays the bootstrap. Self-hosted installs never read these variables.

**When.** About 15 seconds after start, then every 6 hours ± 36 minutes. A
replica skips a scheduled check when another one checked successfully in
the last 4½ hours (5 minutes at start). An administrator can press
**Check now** on Settings → License (once per 30 s). A console that can't
be reached is tried again after 1, 2, 4… minutes, at most an hour apart
(or after its `Retry-After`, between 1 minute and 6 hours).

**What is used.** A fetched license replaces the one in force only when:

1. it verifies with the vendor's public key (the same check as every
   license; nothing weaker);
2. its `workspace` claim is `COMPASSDOCS_WORKSPACE_ID` (a license without
   one is refused);
3. it is active (not past its `expires`; its grace period doesn't count);
4. it is not older or shorter than the license in force: its `expires` is
   no earlier, and its `issued` no earlier.

Otherwise nothing changes: the license in force stays, and Settings →
License says why. The last good license is kept in the database
(`license_cloud` in `settings`), so a restart during a console outage keeps
it; the bootstrap is used only while it is newer (the console redeployed
the workspace with a later one) or while nothing better was fetched.
Every installed renewal is in the audit log ("Installed a renewed license
from CompassDocs Cloud") and the log (`license.renewed`); a run of
failures is one line (`license.console_unreachable`,
`license.console_rejected`, `license.console_unauthorized`,
`license.console_error`) until it changes.

**The HTTP contract** (what the console implements):

- **Request.** `GET <COMPASSDOCS_LICENSE_URL>`, exactly as configured (the
  console decides its shape, e.g.
  `https://console.compassdocs.io/api/workspaces/<id>/license`). Headers:
  - `Authorization: Bearer <credential>`: with `COMPASSDOCS_LICENSE_AUDIENCE`,
    a Microsoft Entra access token for the workspace's managed identity,
    audience = that app ID URI (the console validates issuer, audience and
    expiry, and maps the token's `oid` / `xms_mirid` to the workspace);
    otherwise `COMPASSDOCS_LICENSE_TOKEN`. **The console must identify the
    workspace from the credential**, never from the URL or headers alone,
    and answer only with that workspace's license.
  - `Accept: text/plain`
  - `X-CompassDocs-Workspace: <COMPASSDOCS_WORKSPACE_ID>` (informational;
    the console may check it matches the credential's workspace)
  - `User-Agent: CompassDocs/<version>`, `X-CompassDocs-Version: <version>`
  - `If-None-Match: <ETag>`, when the app holds a license it got from the
    console with an `ETag`.
- **Responses.**

  | Status | Body | The app |
  | --- | --- | --- |
  | `200` | `text/plain`: the license token, `base64url(payload).base64url(signature)`, at most 16 KB (surrounding whitespace ignored). The payload is the usual claims plus `"workspace": "<COMPASSDOCS_WORKSPACE_ID>"`. Send `ETag` (any opaque value, ≤ 200 characters). | Checks it as above; installs it or keeps the one in force. |
  | `304` | none | Unchanged (only when `If-None-Match` was sent). |
  | `204` or `404` | none | The console has no license for this workspace yet; keeps the one in force. |
  | `401` or `403` | any | The credential was refused; keeps the license, logs an error, backs off. |
  | `429`, `5xx` | any | Unreachable; honours `Retry-After` (seconds or a date). |
  | `3xx` | `Location` | Followed only to the same origin (scheme, host and port), at most twice; a redirect to another host is not followed and the credential is never sent there. |
  | anything else | | An error; keeps the license, backs off. |

- **Limits.** 15 seconds for the whole exchange (redirects and body
  included), 16 KB of body, one request at a time per replica.
- **Caching.** The app keeps no HTTP cache of its own: its conditional
  request (`If-None-Match`) is how the console says "nothing new" (`304`).
  The console should send `Cache-Control: no-store` so no proxy between
  them keeps a license.
- **The license.** The console signs it with the vendor's Ed25519 key as
  today, with one more claim, `workspace`. A license for a cloud workspace
  without that claim is refused by the pull (it still works as
  `COMPASSDOCS_LICENSE_KEY`).

### The plan in the license

1.22.0: a CompassDocs Cloud license carries the workspace's plan in one
more signed claim, `cloudPlan`, beside `workspace`. The console signs it
with the vendor's Ed25519 key like every other claim; the app reads it in
one place (`lib/plan` `cloudPlanState()`) and only in cloud mode. Self-hosted
installs, and a cloud workspace on an Enterprise license, ignore it and
keep their seats and agent rules exactly as before.

```json
{
  "id": "lic_…", "customer": "Northwind Traders", "plan": "starter",
  "features": ["helpdesk", "policy_ack", "training"], "seats": 0, "agents": -1,
  "issued": "2026-03-14", "expires": "2027-03-28",
  "workspace": "ws_2c91e4",
  "cloudPlan": {
    "name": "starter",
    "agentsIncluded": 3,
    "agentsMax": 10,
    "activeUsersLimit": 250,
    "storageGb": 25,
    "aiAllowanceUsd": 15,
    "bufferPct": 20,
    "renewsAt": "2027-03-14",
    "billingContact": "billing@northwind.example",
    "priceUsd": 199,
    "billing": "annual"
  }
}
```

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `name` | yes | `"starter"` \| `"shared"` \| `"dedicated"` | The plan. |
| `agentsIncluded` | yes | integer ≥ 0 | Agents the plan includes. Each one past it is an extra agent at $9.99/mo, prorated. |
| `agentsMax` | yes | integer ≥ `agentsIncluded`, or `null` | The plan's agent maximum. New agents are held at the maximum plus the buffer (10 → 12, 25 → 30); `null` means no maximum. |
| `activeUsersLimit` | yes | integer ≥ 0, or `null` | Active users a calendar month (UTC); `null` means no cap. |
| `storageGb` | yes | number ≥ 0, or `null` | Storage included, in GB (10⁹ bytes). Past it, each started 50 GB is $25 a month. `null`: by contract. |
| `aiAllowanceUsd` | yes | number ≥ 0, or `null` | AI included each month, in US dollars at cost. Beyond it, AI is billed at cost +30%. `null`: by contract. |
| `renewsAt` | yes | `YYYY-MM-DD` | The plan's renewal date (an extra agent is prorated to it). |
| `bufferPct` | no (20) | integer 0–100 | The soft buffer above `activeUsersLimit` and `agentsMax`. |
| `billingContact` | no | an email address | Where the warning emails go instead of every admin; an admin can set another on Plan & usage. |
| `priceUsd` | no | number ≥ 0 | The monthly price shown on the plan card; else the published price (Starter $199, Shared $449, Dedicated $2,950). |
| `billing` | no (`"annual"`) | `"annual"` \| `"monthly"` | How the plan is billed: an extra agent is prorated to the renewal ($119.88 a year) or to the month's end. |

**Missing, partial or malformed is no plan.** Every required key must be
present (a limit may be `null`, never absent); a value of the wrong type,
`agentsMax` below `agentsIncluded`, or an optional field that is present
but malformed makes the whole claim read as no plan, never as a guess.
Keep the existing `plan` label claim set to the same name: older versions
read it, and the `cloudPlan` object is a separate claim so that they never
see an object where they expect a string.

**The workspace check (design F).** With `COMPASSDOCS_WORKSPACE_ID` set, a
license carrying `cloudPlan` is used for the plan only when its `workspace`
claim is this workspace: the platform's bootstrap `COMPASSDOCS_LICENSE_KEY`
included, as the console's licenses already are (1.21.3). One that names
another workspace changes nothing: the workspace keeps running on the last
license whose plan matched (kept in the `plan_license_last_match` setting),
never read-only, its admins see a notice naming both workspaces, and the
usage report says so (`licenseMismatch`).

**What a plan turns on** (cloud mode only): Settings → Plan & usage, the
daily count and its report to the console (below), the admin banners and
the threshold email, the price step and the hold in Desk settings →
Agents (the plan's rules replace the `agents` claim), and the monthly AI
cap. Agents are held, never removed; nobody is locked out by any meter.

### Usage to the console

1.22.0: a cloud workspace with a plan counts its usage once a day and
sends the console the counts, with the license request's credential.
**Counts only**: no names, email addresses, document titles, ticket text
or prompts ever leave the workspace. The list of who counted stays in it,
for its admins (Plan & usage → Active users).

**What is counted.** Months are calendar months in UTC.

- `agents`: people with a desk role on the day (the License page's count).
- `activeUsers`: distinct people who signed in or used the app this month
  up to the end of the day: viewers, editors, approvers, admins, agents,
  and requesters who sign in to the customer portal; API tokens and app
  connections count as their person. Never people who only email the help
  address, share-link or public-site visitors, CompassDocs support
  sessions, or disabled accounts.
- `storageBytes`: the stored files (attachments, images, ticket files) plus
  documents' text, version history and the Trash. Never backups, workspace
  exports or the search index.
- `aiUsd`: AI at cost this month up to the end of the day: every request's
  tokens at the provider's price list (the desk's Claude limits use the
  same calculation), by feature.

**When.** About 30 seconds after start, then every 6 hours (with the
license check-in's cadence), and a few minutes after midnight UTC, when the
day that ended is counted a last time. Each run counts under an advisory
lock (replicas count once), keeps 13 months, checks the thresholds, then
sends every day not yet sent, oldest first.

**The HTTP contract** (what the console implements):

- **Request.** `POST <COMPASSDOCS_USAGE_URL>`; unset, it is
  `COMPASSDOCS_LICENSE_URL` with its last path segment replaced by `usage`
  (`https://console.compassdocs.io/api/workspaces/ws_2c91e4/license` →
  `…/ws_2c91e4/usage`). `COMPASSDOCS_USAGE_URL` must be `https://` on the
  license URL's origin (the credential goes with it), or cloud mode does
  not start. Headers:
  - `Authorization: Bearer <credential>`: exactly the license request's
    (the managed identity's Entra token for `COMPASSDOCS_LICENSE_AUDIENCE`,
    else `COMPASSDOCS_LICENSE_TOKEN`). **The console must identify the
    workspace from the credential** and refuse a body for another one.
  - `Content-Type: application/json`, `Accept: application/json`
  - `Idempotency-Key: usage:<workspace>:<day>`
  - `X-CompassDocs-Workspace: <COMPASSDOCS_WORKSPACE_ID>`,
    `User-Agent: CompassDocs/<version>`, `X-CompassDocs-Version: <version>`
- **Body** (`schema` 1; at most 8 KB, about 600 bytes in practice):

  ```json
  {
    "schema": 1,
    "workspace": "ws_2c91e4",
    "day": "2026-11-27",
    "countedAt": "2026-11-28T00:05:12.000Z",
    "appVersion": "1.22.0",
    "licenseId": "lic_01HZX…",
    "plan": "starter",
    "agents": 3,
    "activeUsers": 204,
    "storageBytes": 12025908428,
    "storage": { "files": 6334000000, "documents": 3651000000, "helpdesk": 2040908428 },
    "aiUsd": { "total": 13.1, "desk": 7.85, "ask": 2.4, "write": 2.25, "mcp": 0.6 },
    "licenseMismatch": null
  }
  ```

  | Field | Type | Meaning |
  | --- | --- | --- |
  | `schema` | integer | `1`. A later version adds fields; the console ignores what it doesn't know. |
  | `workspace` | string | `COMPASSDOCS_WORKSPACE_ID`. |
  | `day` | `YYYY-MM-DD` | The UTC day counted. |
  | `countedAt` | ISO 8601 (UTC) | When it was counted. A day is counted several times (every 6 hours, then once after it ends); the newest `countedAt` is the day's count. |
  | `appVersion` | string | The app's version. |
  | `licenseId` | string or `null` | The `id` of the license the plan comes from. |
  | `plan` | string | The plan's `name`. |
  | `agents` | integer | People with a desk role on the day. Bill the month's highest, prorated by day. |
  | `activeUsers` | integer | Distinct active people this month up to the end of `day` (month to date: the month's last day is its total). |
  | `storageBytes` | integer | What counts, in bytes. Bill the month's highest day. |
  | `storage` | object of integers | `files`, `documents` (text, versions, the Trash), `helpdesk` (ticket files and email): they add up to `storageBytes`. |
  | `aiUsd` | object of numbers | AI at cost in US dollars this month up to the end of `day` (month to date), six decimals: `total` and by feature, `desk` (Claude in the desk), `ask` (Ask), `write` (Write and Proofread), `mcp` (AI served to MCP clients). Beyond the plan's `aiAllowanceUsd`, bill × 1.3. |
  | `licenseMismatch` | object or `null` | `{ "licenseWorkspace": "ws_7f3a9c" }` when the license in force names another workspace (design F): the console should raise it to staff. |

- **Idempotency.** One report per workspace and day: the console keeps one
  row per (`workspace`, `day`), the one with the newest `countedAt`. A
  report with the same or an older `countedAt` changes nothing and is still
  answered `2xx`. The `Idempotency-Key` names that row; it is not a
  one-shot key (a later count of the same day carries the same key and must
  replace the row).
- **Responses.**

  | Status | The app |
  | --- | --- |
  | `200`, `201`, `202`, `204` | Stored: the day is marked sent (until it is counted again). Any body is read up to 4 KB and ignored. |
  | `400`, `409`, `413`, `422` | The console refused this body (`{"error": "…"}` is logged): not sent again until the day is counted again; the run goes on to the next day. Use `409` for a workspace that doesn't match the credential. |
  | `401`, `403` | The credential was refused: stops, keeps the days pending, backs off. |
  | `404` | No usage endpoint (yet): stops, tries again in 6 hours. |
  | `429`, `5xx`, no answer | Stops, keeps the days pending, honours `Retry-After` (seconds or a date, between 1 minute and 6 hours). |
  | `3xx` | Never followed (an error): the credential is never sent elsewhere. |

- **Retries.** A failure stops the run and the next try waits 1, 2, 4…
  minutes, at most an hour (± 20%), or the console's `Retry-After`. Days
  are sent oldest first; days older than 35 days are not sent again. A day
  counted again after it was sent is sent again with its new `countedAt`.
- **Limits.** 15 seconds for the whole exchange, 8 KB of request body, 4 KB
  of response read, no redirect followed, one request at a time per
  replica.

The workspace keeps its counts whatever the console answers: Plan & usage
shows them, and nothing about the workspace changes when the console
can't be reached. Log events: `plan.usage_report_failed`,
`plan.usage_report_refused`, `plan.usage_report_ok` (each once until it
changes), `plan.count_failed`, `plan.threshold_email_failed`.

### Support access

Nobody at CompassDocs has standing access to a cloud workspace. With
`COMPASSDOCS_SUPPORT_PUBLIC_KEY` set (1.21.4), a staff member gets in only
with a workspace administrator's approval, for at most 8 hours, and
everything they do is in the workspace's own audit log. Without it (and in
every self-hosted install) none of this exists: no page, no setting, and
the routes below answer `404`.

**The flow.**

1. **The console asks.** Its signing service signs a *request token*; the
   console `POST`s it to the workspace (below). The request waits, for 24
   hours at most, on **Settings → Support access** (People & access, for
   whoever may change users' roles: `user.update_role`, the
   Administrators) and in those administrators' notifications. A workspace
   can turn requests off there ("Let CompassDocs support ask for access").
2. **An administrator approves or denies it.** Approval opens the *window*:
   from now, for the duration the request asked for. They can revoke it at
   any moment: every session it opened ends at once.
3. **The staff member signs in.** The signing service signs a *grant token*
   naming the request, and the staff member's browser opens
   `<COMPASSDOCS_BASE_URL>/login/support#<grant token>`. The token is in
   the fragment, which a browser never sends to a server or puts in a
   referrer, so it is in no log; the page takes it out of the address bar,
   shows who it is for and, on **Sign in as CompassDocs support**, posts it
   (same-origin JSON) to `/api/support/session`. A token works once. The
   session ends at the earlier of the token's `exp` and the window's end.
4. **Emergency access** (off by default; Settings → Support access →
   "Emergency access without approval": read-only, or read-only and
   administrator): a grant token with an `emergency` reason and no request
   opens a session without waiting. The administrators are told at once,
   and every settings page says so until one of them marks it reviewed.

**The support session** is its own service account, "<staff name>
(CompassDocs support)" (`users.status` `service`, `auth_provider`
`compassdocs_support`), never one of the customer's accounts: it isn't
listed in Users, counted as a seat or an administrator, has no password and
no email, and owes no two-step or Duo step. Every page shows a banner: a
CompassDocs support session, read-only or administrator, whose, ending
when, and **End session**.

| | Read-only | Administrator |
| --- | --- | --- |
| Sees | What an administrator sees | The same |
| Changes | Nothing: every request that isn't `GET`/`HEAD`/`OPTIONS` is refused before any route runs (pages' server actions included), and the session holds read permissions only | What an administrator can, except below |
| Never | Its own support access; a workspace export, backups, the Markdown export; account security, API tokens and app (OAuth) connections; the desk's API tokens and webhooks | The same, and changing sign-in, single sign-on, SCIM, Duo, passwords, people, roles, groups, section delegation, the license, webhooks, mail and AI credentials, the directory sync, the public site and share links |

A refused API request answers `403` with `code` `support_read_only` or
`support_not_allowed`; a refused page shows "Not available in a support
session" at its own address.

**Audit.** In the workspace's audit log, category `support`: the request
(`support.requested`), the decision (`support.approved`, `support.denied`,
`support.revoked`, `support.request_expired`), each sign-in
(`support.signed_in`, `support.emergency_access`,
`support.sign_in_refused` with the reason), every page viewed
(`support.page_viewed`) and every change asked for (`support.action`, its
method and path, beside the change's own audit row, whose actor is the
support account), the end of each session (`support.session_ended`: why,
how long, pages viewed, changes), reviews and settings changes. Settings →
Support access lists waiting, active and the last 50 requests, with pages
viewed and changes per request, and opens the log filtered to support.

**The tokens.** A token is the license's shape,
`base64url(payload).base64url(signature)`: the payload is UTF-8 JSON, the
signature is Ed25519 over the payload's bytes exactly as sent, made with the
signing service's private key, and checked against
`COMPASSDOCS_SUPPORT_PUBLIC_KEY` (any of its keys). At most 8 KB.

| Claim | Request token | Grant token |
| --- | --- | --- |
| `typ` | `"compassdocs.support_request"` | `"compassdocs.support_grant"` |
| `v` | `1` | `1` |
| `jti` | The token's id, 16–64 of `A–Z a–z 0–9 _ -`; it becomes the request's id | The token's id; used once |
| `workspace` | `COMPASSDOCS_WORKSPACE_ID`, exactly | The same |
| `staff` | `{"name": "…", "email": "…"}` (1–120 and up to 254 characters; no control or bidi characters) | The same; must be the request's staff member (email, case-insensitive) |
| `reason` | Why, 1–500 characters (shown to administrators) | The same |
| `level` | `"read_only"` (the default) or `"admin"` | At most the request's level (an emergency: at most what the workspace allows) |
| `duration_minutes` | 15–480: how long the access lasts once approved | |
| `request` | | The approved request's id (its request token's `jti`) |
| `emergency` | | Instead of `request`: why it can't wait, 1–500 characters |
| `iat`, `nbf`, `exp` | Unix seconds. `exp` − `iat` ≤ 1 hour (the request is a message, sent once) | Unix seconds: the sign-in can be used between `nbf` and `exp`, and the session ends by `exp`; `exp` − `nbf` ≤ 8 hours |

Refused: a signature that doesn't verify (any byte of payload or signature
changed), the other `typ`, another or no `workspace`, `exp` past or `nbf`
(or `iat`) in the future by more than 60 s, longer than allowed, any claim
missing or malformed, both or neither of `request` and `emergency`, and a
grant token's `jti` already used. A refused sign-in is audited with its
reason; a refusal that depends on the request (not approved yet, a closed
window, another staff member) doesn't spend the token.

**The console's HTTP contract.** Requests are authenticated by the signed
token alone (no cookie, no other credential), are limited to 30 a minute per
address (`429` with `Retry-After`) and every answer is JSON with
`Cache-Control: no-store`. An error is `{"error": "<one sentence>", "code": "<code>"}`.

- `POST /api/support/requests`, body: the request token as `text/plain` (or
  `{"token": "…"}` as `application/json`).

  | Status | Body | When |
  | --- | --- | --- |
  | `201` | `{"request": {"id", "status": "pending", "level", "duration_minutes", "requested_at", "expires_at", "decided_at": null, "window_starts": null, "window_ends": null}}` | Created |
  | `200` | the same | That token's request already exists (a retry is safe) |
  | `401` | `code`: `bad_signature`, `malformed`, `wrong_kind`, `wrong_workspace`, `expired`, `not_yet_valid`, `too_long`, `invalid_claims` | The token was refused |
  | `403` | `code`: `support_requests_off` | The workspace turned requests off |
  | `404` | | Not a cloud workspace with support access |
  | `413`, `415` | | Larger than 8 KB; another content type |
  | `429` | `code`: `too_many_pending` (10 waiting), `too_many_requests` (30 a day), `rate_limited` | |

- `GET /api/support/requests/<id>`, `Authorization: Bearer <that request's
  token>` (valid until its `exp`): `200 {"request": {…}}`, the same fields;
  `status` is `pending`, `approved`, `denied`, `revoked`, `expired` (nobody
  decided in 24 hours) or `ended` (the window closed). `window_starts` and
  `window_ends` say when an approved request's grant tokens can be used.
  `401` (`wrong_request` for another request's token), `404`.
- The sign-in itself is the browser's, never the console's: open
  `<COMPASSDOCS_BASE_URL>/login/support#<grant token>` in the staff member's
  browser. (Its page calls `POST /api/support/session`, same-origin JSON
  `{"token": "…"}`; `DELETE /api/support/session` ends the session.)
  Refusals the staff member sees: `replayed` (`409`), `not_approved`,
  `request_denied`, `request_revoked`, `request_expired`, `wrong_staff`,
  `level_too_high`, `window_closed`, `unknown_request`, `emergency_off`
  (`403`), and the token's own refusals (`401`).

**Key rotation.** Add the new public key beside the old one
(`COMPASSDOCS_SUPPORT_PUBLIC_KEY=<new>,<old>`), roll the revision, switch the
signing service to the new key, then remove the old one. Removing the
variable switches support access off: every support session stops at its
next request.

### Workspace export

A CompassDocs Cloud workspace's administrators (whoever holds
`system.export`) can take a full copy of their workspace, to keep or to
move to a self-hosted CompassDocs (1.21.4): **Settings → Import & export →
Workspace export**. Settings → Backups, which CompassDocs Cloud manages,
links there. Self-hosted installs don't have it; they have Backups.

**What it is.** One POSIX tar archive,
`compassdocs-export-<YYYYMMDD-HHMMSS>.tar`:

| Entry | |
| --- | --- |
| `compassdocs-export-<stamp>/README.md` | How to import it (below), the sizes and SHA-256 of the two data files |
| `compassdocs-export-<stamp>/manifest.json` | `{"format": "compassdocs-workspace-export", "version": 1, "created_at", "compassdocs_version", "workspace_id", "database": {"file", "format", "size", "sha256", "rows_left_out_of"}, "files": {"file", "format", "size", "sha256", "count", "bytes", "skipped_while_exporting"}, "file_store"}` |
| `compassdocs-export-<stamp>/compassdocs-<stamp>.dump` | The database: `pg_dump --format=custom --no-owner --no-privileges`, the same as a backup's, without the rows of `sessions`, `duo_states`, `support_token_uses` and `saml_seen_responses` (who was signed in) |
| `compassdocs-export-<stamp>/compassdocs-<stamp>.files.tar` | Every stored file (attachments, images, logos, newsletter and helpdesk files) under its stored name, in a backup's files format |

The two `compassdocs-<stamp>.*` files are a backup set, unencrypted (a
self-hosted restore reads an unencrypted files half since 1.21.4): copy
them into a self-hosted install's backups volume and restore them from
Settings → Backups, or use them by hand (`pg_restore`, `tar -x` into the
uploads folder). The README in the archive has the commands. Integration
credentials saved in the workspace are encrypted with its
`COMPASSDOCS_SECRET_KEY`, which is not in the export: ask CompassDocs
support for it, or enter them again after importing.

**How it is made.** In the background, in three stages shown on the page
with progress (the database, the files, the archive). Nothing touches the
app's local disk: the dump and the files archive are streamed into the
workspace's file store (its blob container with `COMPASSDOCS_FILE_STORE=blob`,
else the uploads folder, under `exports/`), then the archive is streamed
from them into the store and they are deleted. Memory stays bounded however
large the workspace. The store holds up to about twice the workspace's size
while an export is made. A restart during an export fails it (it says so,
and its pieces are removed); start it again.

**Who and how often.** One export at a time, three started in any 24
hours. A ready export can be downloaded for 7 days, by administrators only,
only through `GET /api/admin/workspace-export/<id>` (single byte ranges, so a
download can resume; `X-Content-SHA256` carries its hash), never from a
public or signed URL, never by a support session, and not when another site
starts the download. It can be deleted sooner. After 7 days it is removed.
Each start, finish, failure, download and deletion is in the audit log
(category `workspace`).

### Moving a self-hosted install to COMPASSDOCS_SECRET_KEY

Self-hosted installs keep working as they are: without
`COMPASSDOCS_SECRET_KEY`, the key lives in a file on the uploads volume
(`/uploads/.secret.key`), created on first start. Moving it into the
environment is optional (it lets you keep the key in a secret store, and
back it up apart from the data it protects). The compose files don't pass
the variable, so nothing changes until you opt in:

1. Read the current key: `docker compose exec app cat /uploads/.secret.key`.
2. Put it in `.env` as `COMPASSDOCS_SECRET_KEY=<that value>`.
3. Pass it to the app in a `docker-compose.override.yml` next to
   `docker-compose.yml` (the installer's updates never touch that file):

   ```yaml
   services:
     app:
       environment:
         COMPASSDOCS_SECRET_KEY: ${COMPASSDOCS_SECRET_KEY}
   ```

4. `docker compose up -d`. Check that a saved credential still works
   (Settings → System → Diagnostics, or send a test email).
5. Keep a copy of the key somewhere safe. You may delete the file once you
   are sure; backups made before then still need the same key to restore.

Use the file's value, not a new key: everything already encrypted (SMTP,
SSO, Microsoft 365 and other credentials, backups) can only be opened with
it. If the variable and the file hold different keys, CompassDocs refuses
to start and its log says which to keep. If the key file is missing while
the database holds encrypted credentials, no new key file is written:
restore the file, or set the variable to the old key (if that key is lost
for good, set the variable to a new one and enter the credentials again).

## Telemetry (OpenTelemetry)

Since 1.21.1 CompassDocs can send **traces and metrics** over OpenTelemetry,
to Azure Application Insights or to any OTLP collector (Grafana, Honeycomb,
Datadog, Jaeger, an OpenTelemetry Collector…). It is **off unless you set
an exporter**, in both modes: with neither variable below set, none of the
telemetry code is even loaded. **Logs are never exported**: they stay on
stdout, where your platform already collects them (Container Apps sends
them to Log Analytics), so sending them again would only double the cost.

| Variable | What it does |
| --- | --- |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Send to Application Insights (the resource's connection string, `InstrumentationKey=…;IngestionEndpoint=https://…`). A malformed one is one warning in the log, and the app runs without it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Send to an OTLP/HTTP collector, e.g. `http://otel-collector:4318` (traces to `/v1/traces`, metrics to `/v1/metrics`). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json`. gRPC is not included. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers for the collector, e.g. its API key: `x-api-key=…`. Treated as a secret (never logged). |
| `OTEL_SDK_DISABLED` | `true` turns telemetry off, whatever else is set. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Sampling. Default: `parentbased_traceidratio`, keeping **every trace self-hosted** and **one in five (0.2) in cloud mode**. `always_on`, `always_off`, `traceidratio` and the `parentbased_*` forms are accepted. |
| `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME` | Extra resource attributes (`deployment.environment.name=prod,…`), and a service name other than `compassdocs`. |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | `none` turns off just traces or just metrics. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between metric exports (default 60000). |

With both exporters set, both receive the same data. Every span and metric
carries `service.name=compassdocs`, `service.version`, `service.instance.id`
(the replica) and `compassdocs.mode`, and in cloud mode
`compassdocs.workspace.id` (`COMPASSDOCS_WORKSPACE_ID`). The Application
Insights exporter's own usage reports to Microsoft (statsbeat) are off and it
keeps nothing on disk; it does fetch its configuration from
`settings.sdk.monitor.azure.com`.

**Traces.** Each request is one span named by its route (`GET /docs/[slug]`,
`POST /api/auth/login`), with Next.js's own spans, the outgoing HTTP calls
(Microsoft Graph, the Anthropic API, Azure Blob, S3, webhooks) and the
Postgres queries beneath it. Each background job run is a span named
`job <name>`, and each SMTP send `smtp send`. `/healthz` and `/readyz` are
never traced. A JSON log line written inside a traced request or job carries
its `trace_id` and `span_id`, and the request span carries the log lines'
`request_id`.

**Metrics** (every 60 s): `http.server.request.duration` (by method,
status code and route; the probes left out), `db.client.connection.count`
(the database pool's `used` and `idle` connections) and
`db.client.connection.pending_requests` (requests waiting for one),
`compassdocs.job.runs` and `compassdocs.job.failures` (by job), and
`compassdocs.mail.sent` and `compassdocs.mail.failed` (by `smtp` or `m365`).

**What is recorded, and what never is**

| Recorded | Never recorded |
| --- | --- |
| The route template (`/docs/[slug]`), method and status code of each request | The request's actual path or query string (they can hold tokens, search terms, return paths) |
| The `user-agent`, `content-type`, `content-length` and `x-request-id` headers | Any other header: no cookies, no `Authorization`, no session |
| Outgoing calls' method, host, status and path | Their query strings, the password in a URL; an email address in a path becomes `[email]` |
| Postgres statement text (`SELECT … WHERE id = $1`) | The query's parameter values |
| Errors' messages and stacks, masked like log lines | Request and response bodies; secret values, bearer tokens and API keys (masked as `[redacted]`, as in the logs); email addresses (`[email]`); client IP addresses |
| Job names, run and failure counts; mail counts by transport | Recipients, subjects or any message content |

**On shutdown** the telemetry still held is sent during the drain, before
the database pool closes, for at most 5 s and never past
`COMPASSDOCS_SHUTDOWN_TIMEOUT`: a collector that hangs never holds up the
exit, and one that is down never stops the app. Export errors are logged
once per distinct error (`"event":"telemetry.error"`), not on every batch.

## How it fits together

```
src/
├── app/
│   ├── (app)/                   Signed-in app: dashboard, spaces, docs, editor,
│   │                            history, search/Ask, directory, links, review,
│   │                            trash, and the admin console
│   ├── (public)/public/         Anonymous public site (opt-in, per space)
│   ├── account/                 Manage account (notifications, 2FA, tokens)
│   └── api/                     REST routes: documents, search, admin, MCP, …
├── components/                  Sidebar, editors, panels, cards, badges
├── ee-stub/                     Open-source stand-in for the enterprise add-ins
└── lib/
    ├── db.ts                    Postgres pool, schema/migration, queries, seeding
    ├── auth.ts / access.ts      Sessions, role guards, space visibility & edit rights
    ├── ai.ts                    RAG answer pipeline + keyword fallback
    ├── webhooks.ts / mailer.ts  Chat + email delivery
    └── license.ts               Offline Ed25519 license verification (fails open)
```

Search stays consistent automatically: the `documents.search` column is a
generated `tsvector` (title + summary + content + tags) with a GIN index, so
Postgres maintains the full-text index on every insert and update — newly
created documents are searchable immediately, ranked with `ts_rank`.

## License

CompassDocs is free and open-source software, licensed under the **GNU Affero
General Public License v3.0 (AGPL-3.0)** — see [`LICENSE`](./LICENSE).

Copyright © 2026 CompassDocs authors.

In plain terms: you can **self-host and use CompassDocs for free**, including in a
company, and modify it however you like. The AGPL's one condition is that if you
run a **modified** version as a **network service** for others, you must make
your modified source available to those users under the same license.

This is the same model as tools like Snipe-IT: the software is fully open and
free to self-host, and a managed **CompassDocs Cloud** hosting tier (run and
maintained for you) is offered separately. The AGPL keeps the self-hosted
edition open while ensuring improvements made in hosted derivatives flow back to
the community.
