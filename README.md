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
| `/readyz` | readiness | 200 `{"status":"ready","migrations":"applied"}` once the schema and its migrations are applied and the database answers within 3 s; 503 with the reason otherwise (`migrations in progress`, `migrations could not run`, `database unreachable`; after a failed migration it reports that failure with a `retry_at` instead of starting the migrations again on every probe), and 503 `{"status":"draining"}` from the moment the process is told to stop. |

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
| `DATABASE_URL` | yes | **Required.** The PostgreSQL connection string. |
| `DATABASE_PASSWORD` | yes | Optional: the database password kept apart from `DATABASE_URL` (it replaces any password in the URL, and in `DATABASE_LISTEN_URL`). Works self-hosted too. |
| `DATABASE_LISTEN_URL` | yes | Optional: a direct connection for the helpdesk's live updates when `DATABASE_URL` is a transaction-mode pooler. |
| `COMPASSDOCS_BASE_URL` | | **Required.** The workspace's public address, e.g. `https://acme.compassdocs.io`. Every link in email, the portal's sign-in links and OAuth redirects are built from it (a custom domain saved earlier is ignored). Missing, not a valid URL or not `https://`, the process logs `Cloud mode (COMPASSDOCS_CLOUD=1) can't start: COMPASSDOCS_BASE_URL …` and exits 1 (a plain-http loopback address, such as `http://localhost:3000` on a developer's machine, only logs a warning). Self-hosted, it stays optional. |
| `COMPASSDOCS_LICENSE_KEY` | yes | When set, the platform's license: it wins over a saved key, and Settings → License shows it read-only, "Set by the platform". |
| `ANTHROPIC_API_KEY` | yes | When set, the platform's AI key: it wins over a saved key and Settings → AI shows it read-only. |
| `COMPASSDOCS_SMTP_HOST`, `COMPASSDOCS_SMTP_PORT` (587), `COMPASSDOCS_SMTP_SECURE` (`starttls`, `tls` or `none`), `COMPASSDOCS_SMTP_USER`, `COMPASSDOCS_SMTP_PASSWORD` (secret), `COMPASSDOCS_SMTP_FROM` | password | When `COMPASSDOCS_SMTP_HOST` is set, the platform's mail relay: Settings → Email shows SMTP read-only, and the workspace can still choose Microsoft 365 instead. Read only in cloud mode. |
| `COMPASSDOCS_SETUP_TOKEN` | yes | The first-run setup token the platform hands the customer. Cloud mode never prints a setup token to the log. |
| `COMPASSDOCS_ADMIN_USER`, `COMPASSDOCS_ADMIN_PASSWORD` | password | Optional: create the first administrator without the setup page. |
| `COMPASSDOCS_METRICS_TOKEN` | yes | Optional: a bearer token for `/metrics`. |
| `COMPASSDOCS_UPLOAD_DIR` | | Where attachments live: a persistent mount (Azure Files). |
| `COMPASSDOCS_LOG_FORMAT` | | Cloud mode logs JSON; `text` switches back to readable lines, redacted the same way. |
| `COMPASSDOCS_SHUTDOWN_TIMEOUT` | | Seconds to drain on `SIGTERM` (default 25). |

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
it. Secrets never appear: the values of the secret variables above, passwords
in connection strings, bearer tokens, API keys and fields named like a secret
are written as `[redacted]`. (`ts` repeats `time` for parsers of the
pre-1.21.0 JSON lines.)

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
