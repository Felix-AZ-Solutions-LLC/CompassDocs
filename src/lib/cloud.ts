// Cloud mode (1.21.0): COMPASSDOCS_CLOUD=1.
//
// CompassDocs Cloud runs each workspace as an Azure Container App managed
// from the CompassDocs console. In that mode the app:
//
//   - never manages its own hosting: the custom domain and HTTPS (Caddy),
//     the self-updater and local backups are the platform's, so their
//     settings are hidden and their APIs answer 403 (CLOUD_AREAS);
//   - takes its secrets from the environment, which Container Apps fills
//     from Key Vault secret references (ENV_SECRETS): the encryption key is
//     required and no key file is ever read or written (lib/secretbox), and a
//     platform secret set in the environment wins over a saved setting and is
//     shown read-only, "Set by the platform";
//   - is probed and stopped by the platform (/healthz, /readyz, SIGTERM:
//     lib/shutdown and start.cjs) and logs one JSON object per line
//     (lib/log).
//
// This is the only place the switch is read. A self-hosted install (the
// variable unset) behaves exactly as before 1.21.0.
//
// No "server-only" marker: the area texts and the inventory are plain data
// that tests and the docs read too. Client components never call isCloud()
// (they can't see the server's environment); a page passes what they need.

/** The environment, or a stand-in for it (tests). */
export type Env = Record<string, string | undefined>;

/** Is this process running as a CompassDocs Cloud workspace? Read on every call (tests flip it). */
export function isCloud(env: Env = process.env): boolean {
  const v = env.COMPASSDOCS_CLOUD?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * One JSON object per log line (lib/log)? In cloud mode, or with
 * COMPASSDOCS_LOG_FORMAT=json; COMPASSDOCS_LOG_FORMAT=text keeps readable
 * lines in cloud mode too. Here rather than in lib/log so the request proxy
 * can ask without loading the logger.
 */
export function jsonLogging(env: Env = process.env): boolean {
  const f = env.COMPASSDOCS_LOG_FORMAT?.trim().toLowerCase();
  if (f === "json") return true;
  if (f === "text") return false;
  return isCloud(env);
}

/** The note that stands in for a hidden area (STYLEGUIDE §Settings pages, "Managed by the platform"). */
export const CLOUD_MANAGED_TITLE = "Managed by CompassDocs Cloud";

/** The label a platform-supplied setting shows instead of its input. */
export const SET_BY_PLATFORM = "Set by the platform";

/** The `code` on every refusal of a hidden area's API. */
export const CLOUD_MANAGED_CODE = "cloud_managed";

/** A part of the app that manages hosting or installs software: hidden and refused in cloud mode. */
export type CloudArea = "domain" | "updates" | "backups";

export interface CloudAreaInfo {
  /** What it is called in the product. */
  label: string;
  /** The settings section it is, when it is a whole section (hidden from the rail and the search). */
  section?: string;
  /** The sentence under "Managed by CompassDocs Cloud". */
  body: string;
}

export const CLOUD_AREAS: Record<CloudArea, CloudAreaInfo> = {
  domain: {
    label: "Domain & HTTPS",
    section: "/admin/domain",
    body: "Your workspace's address and its HTTPS certificate are set up and renewed for you. Contact CompassDocs support to use your own domain.",
  },
  updates: {
    label: "Updates",
    body: "New versions are installed for you, with no downtime.",
  },
  backups: {
    label: "Backups",
    section: "/admin/backups",
    body: "Your workspace's database and files are backed up and kept for you, with point-in-time restore. Contact CompassDocs support to restore.",
  },
};

/** Settings sections that do not exist in cloud mode (rail, search, palette and the desk's address link). */
export const CLOUD_HIDDEN_SECTIONS: readonly string[] = Object.values(CLOUD_AREAS)
  .map((a) => a.section)
  .filter((s): s is string => !!s);

/** Is this settings section hidden in this mode? */
export function sectionHiddenInMode(href: string, env: Env = process.env): boolean {
  return isCloud(env) && CLOUD_HIDDEN_SECTIONS.includes(href);
}

/** The refusal sentence for an area's API. */
export function cloudRefusalMessage(area: CloudArea): string {
  return `${CLOUD_AREAS[area].label} is managed by CompassDocs Cloud, so it can't be changed here.`;
}

// --- Secrets from the environment --------------------------------------------
//
// Every secret the app reads at start-up or keeps in its settings, and how
// cloud mode supplies it. Container Apps maps a Key Vault secret reference
// to each of these environment variables. "platform" secrets, when their
// variable is set in cloud mode, win over anything saved in Settings and the
// setting is shown read-only; unset, the workspace admin keeps setting them.
// Workspace-owned integration secrets (a customer's own Microsoft 365, Slack,
// Teams, SSO, SCIM, Duo, directory and helpdesk connections) are not here:
// they stay in the app's encrypted settings (lib/secretbox).

export type EnvSecretKind = "required" | "env" | "platform";

export interface EnvSecret {
  /** The environment variable. */
  env: string;
  /** What it is. */
  label: string;
  /**
   * required: cloud mode refuses to start without it.
   * env: only ever read from the environment.
   * platform: a setting that the environment overrides in cloud mode (read-only "Set by the platform").
   */
  kind: EnvSecretKind;
  /** The settings key it overrides (platform secrets). */
  setting?: string;
  /** Where its setting lives in the product. */
  where?: string;
}

export const ENV_SECRETS: readonly EnvSecret[] = [
  { env: "COMPASSDOCS_SECRET_KEY", label: "Encryption key for secrets at rest (32 bytes, hex or base64)", kind: "required" },
  { env: "DATABASE_URL", label: "PostgreSQL connection string", kind: "required" },
  { env: "DATABASE_PASSWORD", label: "PostgreSQL password, when it is kept apart from DATABASE_URL", kind: "env" },
  { env: "DATABASE_LISTEN_URL", label: "Direct connection for the helpdesk's live updates (LISTEN), when DATABASE_URL is a pooler", kind: "env" },
  { env: "COMPASSDOCS_LICENSE_KEY", label: "Enterprise license key", kind: "platform", setting: "license_key", where: "/admin/license" },
  { env: "ANTHROPIC_API_KEY", label: "Anthropic API key for AI answers", kind: "platform", setting: "anthropic_api_key", where: "/admin/ai" },
  { env: "COMPASSDOCS_SMTP_PASSWORD", label: "SMTP relay password (with COMPASSDOCS_SMTP_HOST and the other SMTP variables)", kind: "platform", setting: "smtp_pass", where: "/admin/notifications/email" },
  { env: "COMPASSDOCS_SETUP_TOKEN", label: "First-run setup token", kind: "env" },
  { env: "COMPASSDOCS_ADMIN_PASSWORD", label: "First administrator's password (headless set-up)", kind: "env" },
  { env: "COMPASSDOCS_METRICS_TOKEN", label: "Bearer token for /metrics", kind: "env" },
];

/** The value of a platform secret's variable in cloud mode, or null (self-hosted, or the variable unset). */
export function platformValue(envName: string, env: Env = process.env): string | null {
  if (!isCloud(env)) return null;
  const v = env[envName]?.trim();
  return v ? v : null;
}

// --- SMTP from the environment (cloud mode) ----------------------------------

export interface EnvSmtp {
  host: string;
  port: number;
  secure: "tls" | "starttls" | "none";
  user: string;
  pass: string;
  from: string;
}

/**
 * The platform's SMTP relay, in cloud mode with COMPASSDOCS_SMTP_HOST set:
 * COMPASSDOCS_SMTP_PORT (587), COMPASSDOCS_SMTP_SECURE (starttls | tls |
 * none), COMPASSDOCS_SMTP_USER, COMPASSDOCS_SMTP_PASSWORD,
 * COMPASSDOCS_SMTP_FROM. Null otherwise: the saved SMTP settings apply.
 * Self-hosted installs never read these variables.
 */
export function envSmtp(env: Env = process.env): EnvSmtp | null {
  const host = platformValue("COMPASSDOCS_SMTP_HOST", env);
  if (!host) return null;
  const secure = env.COMPASSDOCS_SMTP_SECURE?.trim().toLowerCase();
  return {
    host,
    port: Number(env.COMPASSDOCS_SMTP_PORT) || 587,
    secure: secure === "tls" || secure === "none" ? secure : "starttls",
    user: env.COMPASSDOCS_SMTP_USER?.trim() || "",
    pass: env.COMPASSDOCS_SMTP_PASSWORD || "",
    from: env.COMPASSDOCS_SMTP_FROM?.trim() || "",
  };
}

// --- Start-up checks ----------------------------------------------------------

/** 64 hex characters or base64 of exactly 32 bytes (lib/secretbox parseKeyMaterial). */
export function validKeyMaterial(raw: string | undefined): boolean {
  const s = (raw ?? "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  return Buffer.from(s, "base64").length === 32;
}

/**
 * Why cloud mode must not start, as one sentence each for the log; empty
 * when it may (or when this is not cloud mode). Warnings are said but do
 * not stop it.
 */
export function cloudStartupProblems(env: Env = process.env): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];
  if (!isCloud(env)) return { fatal, warnings };
  const key = env.COMPASSDOCS_SECRET_KEY;
  if (!key?.trim()) {
    fatal.push(
      "COMPASSDOCS_SECRET_KEY is not set. Cloud mode never creates or reads a key file: set it from the workspace's Key Vault secret (32 bytes, as 64 hex or 44 base64 characters)."
    );
  } else if (!validKeyMaterial(key)) {
    fatal.push("COMPASSDOCS_SECRET_KEY must be 32 bytes, as 64 hex or 44 base64 characters.");
  }
  if (!env.DATABASE_URL?.trim()) fatal.push("DATABASE_URL is not set.");
  const base = env.COMPASSDOCS_BASE_URL?.trim();
  if (!base) {
    warnings.push("COMPASSDOCS_BASE_URL is not set: links in email are relative and the customer portal sends no sign-in links until it is.");
  } else {
    try {
      const u = new URL(base);
      if (u.protocol !== "https:") warnings.push(`COMPASSDOCS_BASE_URL should be an https:// address (it is ${u.protocol}//…).`);
    } catch {
      warnings.push("COMPASSDOCS_BASE_URL is not a valid URL: links in email are relative until it is.");
    }
  }
  return { fatal, warnings };
}
