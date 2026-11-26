// On-demand self-diagnostics for the admin System page: is each subsystem
// healthy, degraded, or unconfigured? Every check is defensive — a failing
// subsystem yields a "fail" result, never an exception. Server-only.

import "server-only";
import { isCloud } from "./cloud";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { pool } from "./db";
import { uploadDir } from "./uploads";
import { fileStore, fileStoreKind, storeProblem } from "./file-store";
import { getSmtpConfig, smtpConfigured } from "./smtp-config";
import { SECRET_UNREADABLE, getM365SendConfig, getMailMethod, m365SendConfigured } from "./mail-config";
import { probeM365Send } from "./mail-m365";
import { MAIL_CHECK_FRESH_MS, secretExpiry, secretExpirySentence, type MailM365Check } from "./mail-m365-shared";
import { aiAvailable, getAiProvider } from "./ai-config";
import { getEmbeddingsConfig, vectorAvailable } from "./embeddings";
import { licenseState } from "./license";
import { featureEnabled } from "./ee";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /**
   * The settings page that fixes a non-pass outcome, when one exists. Only set
   * where a page really owns the fix — database, upload storage, metrics and
   * outbound egress are container/server configuration with no page.
   */
  fix?: { href: string; label: string };
}

const FIX = {
  smtp: { href: "/admin/notifications/email", label: "Set up SMTP" },
  m365: { href: "/admin/notifications/email", label: "Set up Microsoft 365" },
  ai: { href: "/admin/ai", label: "Connect a provider" },
  semantic: { href: "/admin/ai", label: "Semantic search settings" },
  license: { href: "/admin/license", label: "Open License" },
  agents: { href: "/desk/settings/agents", label: "Open Agents" },
  domain: { href: "/admin/domain", label: "Open Domain & HTTPS" },
} as const;

async function checkDatabase(): Promise<DiagnosticCheck> {
  const started = Date.now();
  try {
    await pool().query("SELECT 1");
    const ms = Date.now() - started;
    return {
      key: "database",
      label: "Database",
      status: ms > 250 ? "warn" : "pass",
      detail: `Reachable, ${ms} ms round-trip.${ms > 250 ? " Slow — check network or load." : ""}`,
    };
  } catch (e) {
    return {
      key: "database",
      label: "Database",
      status: "fail",
      detail: e instanceof Error ? e.message : "Unreachable.",
    };
  }
}

async function checkUploads(): Promise<DiagnosticCheck> {
  // 1.21.2: the blob store (lib/file-store): a probe blob written and removed.
  if (fileStoreKind() === "blob") {
    const store = fileStore();
    try {
      await store.check({ write: true, timeoutMs: 10_000 });
      return { key: "uploads", label: "Upload storage", status: "pass", detail: `Writable in ${store.describe()}.` };
    } catch (e) {
      return { key: "uploads", label: "Upload storage", status: "fail", detail: storeProblem(e, store).message };
    }
  }
  const dir = uploadDir();
  const probe = join(dir, `.diag-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, "ok");
    await unlink(probe);
    return { key: "uploads", label: "Upload storage", status: "pass", detail: `Writable at ${dir}.` };
  } catch (e) {
    return {
      key: "uploads",
      label: "Upload storage",
      status: "fail",
      detail: `Cannot write to ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Email, by the chosen method (1.20.31): "Email (SMTP)" as before, or
 * "Email (Microsoft 365)": the last Check connection (lib/mail-m365
 * probeM365Send: the app signs in and Graph is asked whether it may send as
 * the mailbox, sending nothing). A page render never calls Microsoft: it
 * shows the last check. `live` (the Diagnostics card's Run checks) checks
 * again when the last one is older than MAIL_CHECK_FRESH_MS, within 15
 * seconds. A client secret that ends within 30 days is a warning; one that
 * has ended, a failure; an app that can send as other mailboxes too, a
 * warning.
 */
export async function checkMail(opts: { live?: boolean } = {}): Promise<DiagnosticCheck> {
  let method: "smtp" | "m365" = "smtp";
  try {
    method = await getMailMethod();
    if (method === "m365") return await checkM365Mail(opts.live === true);
    const cfg = await getSmtpConfig();
    if (!smtpConfigured(cfg)) {
      return {
        key: "smtp",
        label: "Email (SMTP)",
        status: "warn",
        detail: "Not configured — subscriptions, reminders, and newsletters can't send.",
        fix: FIX.smtp,
      };
    }
    return {
      key: "smtp",
      label: "Email (SMTP)",
      status: "pass",
      detail: `Configured for ${cfg.host}:${cfg.port}.`,
    };
  } catch (e) {
    return {
      key: "smtp",
      label: method === "m365" ? "Email (Microsoft 365)" : "Email (SMTP)",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
      fix: method === "m365" ? FIX.m365 : FIX.smtp,
    };
  }
}

const PROBE_BUDGET_MS = 15_000;

/**
 * 1.20.32: the outbox of email through Microsoft 365 (lib/mail-outbox).
 * Shown while Microsoft 365 is chosen or anything is left in it: paused by a
 * refusal (fail), paused because Microsoft asked to slow down or messages
 * that failed or may not have gone out (warn), else how much waits.
 */
export async function checkOutbox(): Promise<DiagnosticCheck | null> {
  try {
    const { outboxView } = await import("./mail-outbox");
    const v = await outboxView();
    if (!v.m365 && !v.queued && !v.problems_total) return null;
    const fix = { href: "/admin/notifications/email#outbox", label: "Open the outbox" };
    const label = "Email outbox";
    if (v.paused?.kind === "refusal") return { key: "mail_outbox", label, status: "fail", detail: `Paused: ${v.paused.reason} ${v.queued} waiting.`, fix };
    if (v.problems_total) {
      return { key: "mail_outbox", label, status: "warn", detail: `${v.problems_total === 1 ? "1 email" : `${v.problems_total} emails`} failed or may not have gone out. ${v.queued} waiting.`, fix };
    }
    if (v.paused) return { key: "mail_outbox", label, status: "warn", detail: `Microsoft 365 asked to slow down; sending resumes at ${v.paused.until?.slice(11, 16) ?? "soon"} UTC. ${v.queued} waiting.`, fix };
    return { key: "mail_outbox", label, status: "pass", detail: `${v.queued} waiting, ${v.sent_last_hour} sent in the last hour, ${v.day_recipients.toLocaleString("en-US")} of ${v.daily_limit.toLocaleString("en-US")} recipients today.` };
  } catch (e) {
    return { key: "mail_outbox", label: "Email outbox", status: "warn", detail: e instanceof Error ? e.message : "Could not read the outbox." };
  }
}

async function checkM365Mail(live: boolean): Promise<DiagnosticCheck> {
  const label = "Email (Microsoft 365)";
  const cfg = await getM365SendConfig();
  if (!m365SendConfigured(cfg)) {
    return { key: "smtp", label, status: "warn", detail: "Not set up — subscriptions, reminders, and newsletters can't send.", fix: FIX.m365 };
  }
  if (cfg.secretUnreadable) return { key: "smtp", label, status: "fail", detail: SECRET_UNREADABLE, fix: FIX.m365 };
  let check: MailM365Check | null = cfg.lastCheck;
  const age = check ? Date.now() - Date.parse(check.at) : Infinity;
  if (live && !(age < MAIL_CHECK_FRESH_MS)) {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), PROBE_BUDGET_MS).unref?.());
    // The other mailbox the last check tried, so the lock-down state stays known.
    check = (await Promise.race([probeM365Send({ cfg, other: cfg.lastCheck?.other || null }), timeout])) ?? check;
  }
  const expiry = secretExpiry(cfg.secretExpires);
  if (!check) return { key: "smtp", label, status: "warn", detail: "Not checked yet. Press Run checks, or Check connection on the Email settings page.", fix: FIX.m365 };
  const when = ` Checked ${new Date(check.at).toISOString().slice(0, 16).replace("T", " ")} UTC.`;
  if (!check.ok) return { key: "smtp", label, status: "fail", detail: `${check.message}${when}`, fix: FIX.m365 };
  if (expiry.state === "expired" || expiry.state === "soon") {
    return { key: "smtp", label, status: expiry.state === "expired" ? "fail" : "warn", detail: secretExpirySentence(cfg.secretExpires), fix: FIX.m365 };
  }
  if (check.limited === false) {
    return { key: "smtp", label, status: "warn", detail: `The app can send as other mailboxes too, not only ${cfg.mailbox}. Run the lock-down commands on the Email settings page.${when}`, fix: FIX.m365 };
  }
  return { key: "smtp", label, status: "pass", detail: `Signed in and allowed to send as ${cfg.mailbox}. Nothing was sent to check it.${when}` };
}

async function checkAi(): Promise<DiagnosticCheck> {
  try {
    const [ok, provider] = await Promise.all([aiAvailable(), getAiProvider()]);
    return ok
      ? { key: "ai", label: "AI assistant", status: "pass", detail: `Ready (${provider}).` }
      : {
          key: "ai",
          label: "AI assistant",
          status: "warn",
          detail: "Not configured — Ask, proofreading, and writing help are off.",
          fix: FIX.ai,
        };
  } catch (e) {
    return { key: "ai", label: "AI assistant", status: "fail", detail: e instanceof Error ? e.message : String(e), fix: FIX.ai };
  }
}

async function checkSemantic(): Promise<DiagnosticCheck> {
  try {
    const cfg = await getEmbeddingsConfig();
    if (cfg.provider === "off") {
      return {
        key: "semantic",
        label: "Semantic search",
        status: "warn",
        detail: "Disabled — search is keyword-only.",
        fix: FIX.semantic,
      };
    }
    const vector = await vectorAvailable();
    return vector
      ? { key: "semantic", label: "Semantic search", status: "pass", detail: "Enabled, pgvector available." }
      : {
          key: "semantic",
          label: "Semantic search",
          status: "fail",
          detail: "Enabled but the pgvector extension is unavailable in this database.",
          fix: FIX.semantic,
        };
  } catch (e) {
    return {
      key: "semantic",
      label: "Semantic search",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
      fix: FIX.semantic,
    };
  }
}

async function checkLicense(): Promise<DiagnosticCheck> {
  try {
    const s = await licenseState();
    switch (s.status) {
      case "active":
        return {
          key: "license",
          label: "License",
          status: "pass",
          detail: `${s.license.plan} — ${s.daysLeft} days remaining.`,
        };
      case "grace":
        return {
          key: "license",
          label: "License",
          status: "warn",
          detail: `Expired — in grace period, ${s.daysLeft} days left to renew.`,
          fix: FIX.license,
        };
      case "expired":
        return { key: "license", label: "License", status: "warn", detail: "Expired — enterprise features are off.", fix: FIX.license };
      case "invalid":
        return { key: "license", label: "License", status: "fail", detail: `Invalid: ${s.reason}`, fix: FIX.license };
      default:
        return { key: "license", label: "License", status: "pass", detail: "Community edition (no license needed)." };
    }
  } catch (e) {
    return { key: "license", label: "License", status: "fail", detail: e instanceof Error ? e.message : String(e), fix: FIX.license };
  }
}

/** The helpdesk agent allowance against the people on Settings → Agents (only when the helpdesk is on). Exported for tests. */
export async function checkHelpdeskAgents(): Promise<DiagnosticCheck | null> {
  const base = { key: "helpdesk_agents", label: "Helpdesk agents" } as const;
  try {
    if (!(await featureEnabled("helpdesk"))) return null;
    const { agentUsage } = await import("./helpdesk/roles-agents");
    const { licensed, enforced, used, over } = await agentUsage();
    const agents = (n: number) => `${n} agent${n === 1 ? "" : "s"}`;
    if (licensed === null) {
      return { ...base, status: "pass", detail: `${agents(used)} on the desk; the license has no agent limit.` };
    }
    if (!enforced) {
      // The helpdesk is on, so the licence is in grace: the key's number shows, nothing is refused.
      return {
        ...base,
        status: "warn",
        detail: `${used} of ${agents(licensed)} in use; not enforced while the license is in grace${over > 0 ? `, over by ${over} once renewed` : ""}.`,
        fix: FIX.license,
      };
    }
    if (over > 0) {
      return {
        ...base,
        status: "warn",
        detail: `${used} of ${agents(licensed)} in use: over the license by ${over}. Nobody loses access, but no one new can be added until agents are removed or more are bought.`,
        fix: FIX.agents,
      };
    }
    return { ...base, status: "pass", detail: `${used} of ${agents(licensed)} in use.` };
  } catch (e) {
    return { ...base, status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

function checkMetrics(): DiagnosticCheck {
  const token = process.env.COMPASSDOCS_METRICS_TOKEN?.trim();
  return {
    key: "metrics",
    label: "Metrics endpoint",
    status: "pass",
    detail: token
      ? "/metrics is scrapeable with the configured bearer token."
      : "/metrics is admin-session-only (set COMPASSDOCS_METRICS_TOKEN to allow a Prometheus scraper).",
  };
}

/** The Claude/MCP connector is only as healthy as the OAuth endpoints the
 * discovery document advertises — and a bad advertisement (plain-http issuer,
 * stale custom domain, proxy that forgot X-Forwarded-Proto) is invisible from
 * inside the app: everything works in the browser while every OAuth client
 * gets "unable to connect". This check surfaces exactly what we advertise
 * and probes it from the server. */
async function checkMcpConnector(req: Request): Promise<DiagnosticCheck> {
  const key = "mcp";
  const label = "Claude connector (MCP)";
  try {
    const { publicOrigin, requestOrigin } = await import("./oauth");
    const { getAppSettings } = await import("./settings-store");
    const customDomain = (await getAppSettings()).custom_domain?.trim() ?? "";
    const issuer = await publicOrigin(req);
    const fromRequest = requestOrigin(req);
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(issuer);
    const problems: string[] = [];
    let status: CheckStatus = "pass";

    if (issuer.startsWith("http://") && !isLocal) {
      status = "fail";
      problems.push(
        customDomain
          ? "The custom domain resolves to a plain-http issuer — that shouldn't happen; re-save Settings → Domain & HTTPS."
          : "Endpoints are advertised as plain http:// — OAuth clients refuse them. Set the custom domain under Settings → Domain & HTTPS, or make the reverse proxy forward X-Forwarded-Proto: https."
      );
    }

    if (customDomain) {
      let reqHost = "";
      try {
        reqHost = new URL(fromRequest).host;
      } catch {}
      if (reqHost && reqHost !== customDomain && !/^(localhost|127\.0\.0\.1)(:|$)/.test(reqHost)) {
        if (status === "pass") status = "warn";
        problems.push(
          `You're browsing on ${reqHost} but the connector advertises ${customDomain} — if that domain is stale, Claude can't reach the sign-in service. Update Settings → Domain & HTTPS.`
        );
      }
    } else if (!isLocal && !req.headers.get("x-forwarded-proto")) {
      if (status === "pass") status = "warn";
      problems.push(
        "No custom domain is set and the proxy isn't sending X-Forwarded-Proto, so advertised URLs depend on request headers. Setting the custom domain makes the connector immune to proxy misconfiguration."
      );
    }

    // Probe the advertised discovery URL from the server. Reachability from
    // here isn't proof Claude can reach it — but unreachable from here (DNS,
    // TLS, wrong host) almost always means unreachable from everywhere.
    if (!isLocal && issuer.startsWith("https://")) {
      try {
        const { safeFetch } = await import("./safe-fetch");
        const res = await safeFetch(`${issuer}/.well-known/oauth-authorization-server`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          status = "fail";
          problems.push(
            `The advertised discovery URL returned HTTP ${res.status} — the sign-in service isn't being served at ${issuer}.`
          );
        } else {
          const body = (await res.json().catch(() => null)) as { issuer?: string } | null;
          if (body?.issuer && body.issuer !== issuer) {
            if (status === "pass") status = "warn";
            problems.push(
              `${issuer} answers, but advertises a different issuer (${body.issuer}) — two installs or a proxy rewrite?`
            );
          }
        }
      } catch (e) {
        status = "fail";
        problems.push(
          `Couldn't reach the advertised discovery URL from the server (${
            e instanceof Error ? e.message : String(e)
          }) — check DNS and the TLS certificate for ${issuer}.`
        );
      }
    }

    const summary = `Sign-in advertised at ${issuer}/oauth/authorize${
      customDomain ? " (from the custom domain setting)" : " (derived from request headers)"
    }.`;
    // Every non-pass outcome here is cured (or at least diagnosed) by the
    // custom-domain setting, which the problem texts already point at.
    return {
      key,
      label,
      status,
      detail: problems.length ? `${summary} ${problems.join(" ")}` : `${summary} Discovery, authorize, and token endpoints all line up.`,
      // (1.21.0: not in cloud mode, where the platform owns the address: lib/cloud.)
      ...(status !== "pass" && !isCloud() ? { fix: FIX.domain } : {}),
    };
  } catch (e) {
    return { key, label, status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Run every check in parallel. Never throws. */
/** Outbound HTTPS: can this server reach vendor status pages (and webhooks,
 * AI providers, …)? Locked-down VMs — Azure NSGs, forced proxies — fail here
 * while everything inbound works, which is otherwise invisible. */
async function checkOutboundHttps(): Promise<DiagnosticCheck> {
  const proxy = (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  ).trim();
  const via = proxy ? " via the configured proxy (HTTPS_PROXY)" : "";
  const started = Date.now();
  try {
    const { safeFetch } = await import("./safe-fetch");
    const res = await safeFetch("https://www.githubstatus.com/api/v2/status.json", {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    return {
      key: "outbound",
      label: "Outbound HTTPS (status polls, webhooks, AI)",
      status: "pass",
      detail: `Vendor status pages reachable${via}, ${Date.now() - started} ms.`,
    };
  } catch (e) {
    // "fetch failed" hides the real reason (DNS, tunnel refused, TLS) in the
    // cause chain — walk it so the admin sees something actionable.
    const parts: string[] = [];
    for (let err: unknown = e; err instanceof Error && parts.length < 4; err = err.cause) {
      if (err.message && err.message !== parts[parts.length - 1]) parts.push(err.message);
    }
    const msg = parts.join(" — ") || String(e);
    return {
      key: "outbound",
      label: "Outbound HTTPS (status polls, webhooks, AI)",
      status: "fail",
      detail:
        `Could not reach a public status page${via}: ${msg}. ` +
        (proxy
          ? "Check the proxy address and that it allows this destination."
          : "If this network blocks direct egress, allow outbound 443 — or set HTTPS_PROXY (and NO_PROXY) on the container; CompassDocs routes its outbound requests through it."),
    };
  }
}

/** `live`: the Diagnostics card's Run checks (the API), which may call out; a page render passes nothing and never waits on Microsoft. */
export async function runDiagnostics(req?: Request, opts: { live?: boolean } = {}): Promise<DiagnosticCheck[]> {
  const checks = await Promise.all([
    checkDatabase(),
    checkUploads(),
    checkMail({ live: opts.live === true }),
    checkOutbox(),
    checkAi(),
    checkSemantic(),
    checkLicense(),
    checkHelpdeskAgents(),
    Promise.resolve(checkMetrics()),
    checkOutboundHttps(),
    ...(req ? [checkMcpConnector(req)] : []),
  ]);
  return checks.filter((c): c is DiagnosticCheck => c !== null);
}
