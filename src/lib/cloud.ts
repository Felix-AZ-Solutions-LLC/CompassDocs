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

/**
 * Is this settings section hidden in this mode? The platform's areas in
 * cloud mode; and (1.21.4) Support access everywhere but a cloud workspace
 * with support access configured (lib/support), so a self-hosted install's
 * rail, search and palette are unchanged.
 */
export function sectionHiddenInMode(href: string, env: Env = process.env): boolean {
  if (href === SUPPORT_SECTION) return !supportAccessEnabled(env);
  // 1.22.0: Plan & usage exists only in cloud mode (and only with a plan: lib/auth reachableSettingsSections asks lib/plan).
  if (href === PLAN_SECTION) return !isCloud(env);
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
  // 1.21.3: the bearer token for the console's licence endpoint, when it is not reached with the managed identity (lib/license-pull).
  { env: "COMPASSDOCS_LICENSE_TOKEN", label: "Bearer token for the CompassDocs console's license endpoint (COMPASSDOCS_LICENSE_URL), when it is not reached with the managed identity", kind: "env" },
  { env: "ANTHROPIC_API_KEY", label: "Anthropic API key for AI answers", kind: "platform", setting: "anthropic_api_key", where: "/admin/ai" },
  { env: "COMPASSDOCS_SMTP_PASSWORD", label: "SMTP relay password (with COMPASSDOCS_SMTP_HOST and the other SMTP variables)", kind: "platform", setting: "smtp_pass", where: "/admin/notifications/email" },
  { env: "COMPASSDOCS_SETUP_TOKEN", label: "First-run setup token", kind: "env" },
  { env: "COMPASSDOCS_ADMIN_PASSWORD", label: "First administrator's password (headless set-up)", kind: "env" },
  { env: "COMPASSDOCS_METRICS_TOKEN", label: "Bearer token for /metrics", kind: "env" },
];

// --- The license from the console (1.21.3, lib/license-pull) ----------------

/** How the workspace signs in to the console's license endpoint. */
export type LicensePullAuth = { kind: "entra"; audience: string; scope: string } | { kind: "token"; token: string };

export interface LicensePullConfig {
  /** COMPASSDOCS_LICENSE_URL: where the signed license is fetched from (GET). */
  url: URL;
  /** COMPASSDOCS_WORKSPACE_ID: the license must name it (its `workspace` claim). */
  workspaceId: string;
  auth: LicensePullAuth;
}

/** The scope of an access token for an app ID URI (`api://…` or `https://…`): its /.default. */
export function audienceScope(audience: string): string {
  const a = audience.trim();
  return a.endsWith("/.default") ? a : `${a.replace(/\/+$/, "")}/.default`;
}

function loopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host);
}

/**
 * The console's license endpoint, in cloud mode with COMPASSDOCS_LICENSE_URL
 * set: the URL, the workspace and the credential
 * (COMPASSDOCS_LICENSE_AUDIENCE: an Entra token for the managed identity,
 * recommended; else COMPASSDOCS_LICENSE_TOKEN, a bearer token). Null when it
 * is not configured, self-hosted, or misconfigured (cloudStartupProblems
 * says why, and cloud mode does not start).
 */
export function licensePullConfig(env: Env = process.env): LicensePullConfig | null {
  const raw = platformValue("COMPASSDOCS_LICENSE_URL", env);
  if (!raw || licensePullProblems(env).length) return null;
  const audience = env.COMPASSDOCS_LICENSE_AUDIENCE?.trim();
  const token = env.COMPASSDOCS_LICENSE_TOKEN?.trim();
  return {
    url: new URL(raw),
    workspaceId: env.COMPASSDOCS_WORKSPACE_ID!.trim(),
    auth: audience ? { kind: "entra", audience, scope: audienceScope(audience) } : { kind: "token", token: token! },
  };
}

/** Why the license endpoint's settings can't work (cloud mode with COMPASSDOCS_LICENSE_URL set); empty otherwise. */
export function licensePullProblems(env: Env = process.env): string[] {
  const raw = platformValue("COMPASSDOCS_LICENSE_URL", env);
  if (!raw) return [];
  const out: string[] = [];
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    out.push("COMPASSDOCS_LICENSE_URL is not a valid URL.");
  }
  if (u && u.protocol !== "https:" && !(u.protocol === "http:" && loopbackHost(u.hostname))) {
    out.push(`COMPASSDOCS_LICENSE_URL must be an https:// address (it is ${u.protocol}//…).`);
  }
  if (u && (u.username || u.password)) out.push("COMPASSDOCS_LICENSE_URL must not carry a user name or password: use COMPASSDOCS_LICENSE_AUDIENCE or COMPASSDOCS_LICENSE_TOKEN.");
  if (!env.COMPASSDOCS_WORKSPACE_ID?.trim()) {
    out.push("COMPASSDOCS_WORKSPACE_ID is not set. A license fetched from COMPASSDOCS_LICENSE_URL is accepted only when it names this workspace.");
  }
  if (!env.COMPASSDOCS_LICENSE_AUDIENCE?.trim() && !env.COMPASSDOCS_LICENSE_TOKEN?.trim()) {
    out.push(
      "COMPASSDOCS_LICENSE_URL is set without a credential: set COMPASSDOCS_LICENSE_AUDIENCE to the console's app ID URI (the managed identity signs in) or COMPASSDOCS_LICENSE_TOKEN."
    );
  }
  return out;
}

// --- Usage to the console (1.22.0, lib/plan-report) ------------------------------
//
// The daily counts go to the console with the licence's credential, so to
// the same origin as COMPASSDOCS_LICENSE_URL: COMPASSDOCS_USAGE_URL when set
// (it must be on that origin, or the credential would go elsewhere), else
// the licence URL with its last path segment replaced by "usage"
// (https://console.example/api/cloud/license → …/api/cloud/usage).

/** Why COMPASSDOCS_USAGE_URL can't be used (cloud mode with it set); empty otherwise. */
export function usageReportProblems(env: Env = process.env): string[] {
  const raw = platformValue("COMPASSDOCS_USAGE_URL", env);
  if (!raw) return [];
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    return ["COMPASSDOCS_USAGE_URL is not a valid URL."];
  }
  const out: string[] = [];
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopbackHost(u.hostname))) out.push(`COMPASSDOCS_USAGE_URL must be an https:// address (it is ${u.protocol}//…).`);
  if (u.username || u.password) out.push("COMPASSDOCS_USAGE_URL must not carry a user name or password.");
  const lic = platformValue("COMPASSDOCS_LICENSE_URL", env);
  let licOrigin = "";
  try {
    licOrigin = lic ? new URL(lic).origin : "";
  } catch {
    /* licensePullProblems says so */
  }
  if (!lic) out.push("COMPASSDOCS_USAGE_URL is set without COMPASSDOCS_LICENSE_URL: usage is sent with the license endpoint's credential.");
  else if (licOrigin && u.origin !== licOrigin) {
    out.push(`COMPASSDOCS_USAGE_URL must be on the license endpoint's origin (${licOrigin}): usage is sent with the same credential.`);
  }
  return out;
}

/** Where the daily usage report goes (cloud mode with the license endpoint configured), or null. */
export function usageReportUrl(env: Env = process.env): URL | null {
  const pull = licensePullConfig(env);
  if (!pull || usageReportProblems(env).length) return null;
  const raw = platformValue("COMPASSDOCS_USAGE_URL", env);
  if (raw) return new URL(raw);
  // The license URL's last path segment, trailing slashes aside, becomes "usage".
  const base = new URL(pull.url);
  base.pathname = base.pathname.replace(/\/+$/, "");
  base.search = "";
  base.hash = "";
  return new URL("usage", base);
}

/** In cloud mode, is the license CompassDocs Cloud's (from the environment or the console), so read-only here? */
export function licenseManagedByCloud(env: Env = process.env): boolean {
  return !!(platformValue("COMPASSDOCS_LICENSE_KEY", env) || platformValue("COMPASSDOCS_LICENSE_URL", env));
}

// --- Support access (1.21.4, lib/support) ------------------------------------
//
// COMPASSDOCS_SUPPORT_PUBLIC_KEY: the public half of the Ed25519 key the
// console's signing service signs support tokens with (lib/support-token).
// Only in cloud mode, and only with COMPASSDOCS_WORKSPACE_ID (a token must
// name this workspace). Never the license key: a different key, a different
// signer. Up to SUPPORT_MAX_KEYS keys, comma-separated, so the signing key
// can be rotated without a gap. Self-hosted, never read: support access does
// not exist there.

/** The Ed25519 SubjectPublicKeyInfo prefix (DER): 12 bytes, then the 32-byte key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** The vendor's license key (lib/license), which must never be used here. Compared by value, not imported. */
const LICENSE_KEY_FINGERPRINT = "df38f60f754bc888a3fd2a2fb69656c18d7116b5fc17a9fcefa18f212567c44d";
export const SUPPORT_MAX_KEYS = 3;

/** The 44 DER bytes of one key written as base64 SPKI or PEM, or null when it isn't one. */
export function supportKeyDer(raw: string): Buffer | null {
  const body = raw
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const der = Buffer.from(body, "base64");
  return der.length === 44 && der.subarray(0, 12).equals(ED25519_SPKI_PREFIX) ? der : null;
}

/** The keys COMPASSDOCS_SUPPORT_PUBLIC_KEY names (raw strings, unchecked). */
function supportKeyItems(env: Env): string[] {
  return (env.COMPASSDOCS_SUPPORT_PUBLIC_KEY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SupportAccessConfig {
  /** COMPASSDOCS_WORKSPACE_ID: every support token must name it. */
  workspaceId: string;
  /** The signing service's public keys (Ed25519 SPKI DER, 44 bytes each). */
  keys: Buffer[];
}

/** Why support access can't work as configured (cloud mode with the key set); empty otherwise. */
export function supportAccessProblems(env: Env = process.env): string[] {
  if (!isCloud(env)) return [];
  const items = supportKeyItems(env);
  if (!items.length) return [];
  const out: string[] = [];
  if (items.length > SUPPORT_MAX_KEYS) out.push(`COMPASSDOCS_SUPPORT_PUBLIC_KEY holds ${items.length} keys; at most ${SUPPORT_MAX_KEYS} (comma-separated) are read.`);
  items.forEach((item, i) => {
    const der = supportKeyDer(item);
    const which = items.length > 1 ? ` (key ${i + 1})` : "";
    if (!der) out.push(`COMPASSDOCS_SUPPORT_PUBLIC_KEY${which} is not an Ed25519 public key: give it as base64 (SubjectPublicKeyInfo, "MCowBQYDK2VwAyEA…") or PEM.`);
    else if (der.subarray(12).toString("hex") === LICENSE_KEY_FINGERPRINT) {
      out.push(`COMPASSDOCS_SUPPORT_PUBLIC_KEY${which} is the license key. Support tokens are signed by the console's own signing key: give its public key.`);
    }
  });
  if (!env.COMPASSDOCS_WORKSPACE_ID?.trim()) {
    out.push("COMPASSDOCS_WORKSPACE_ID is not set. A support token is accepted only when it names this workspace.");
  }
  return out;
}

/**
 * Support access (lib/support), in cloud mode with
 * COMPASSDOCS_SUPPORT_PUBLIC_KEY set and valid: the workspace and the keys.
 * Null otherwise: self-hosted, not configured, or misconfigured (cloud mode
 * then does not start; cloudStartupProblems says why). Read on every call.
 */
export function supportAccessConfig(env: Env = process.env): SupportAccessConfig | null {
  if (!isCloud(env)) return null;
  const items = supportKeyItems(env);
  if (!items.length || supportAccessProblems(env).length) return null;
  return { workspaceId: env.COMPASSDOCS_WORKSPACE_ID!.trim(), keys: items.map((i) => supportKeyDer(i)!) };
}

/** Is support access switched on (cloud mode, a valid key)? */
export function supportAccessEnabled(env: Env = process.env): boolean {
  return supportAccessConfig(env) !== null;
}

/** 1.22.0: the Plan & usage section (lib/plan): cloud mode with a plan in the licence only. */
export const PLAN_SECTION = "/admin/plan";

/** Settings sections that exist only in cloud mode with support access on. */
export const SUPPORT_SECTION = "/admin/support-access";

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
  // 1.21.3: the license from the console (lib/license-pull).
  fatal.push(...licensePullProblems(env));
  // 1.22.0: where the daily usage goes (lib/plan-report), when set apart from the license URL.
  fatal.push(...usageReportProblems(env));
  // 1.21.4: support access (lib/support): a key that isn't one, the license key, or no workspace id.
  fatal.push(...supportAccessProblems(env));
  if (env.COMPASSDOCS_LICENSE_AUDIENCE?.trim() && env.COMPASSDOCS_LICENSE_TOKEN?.trim()) {
    warnings.push("COMPASSDOCS_LICENSE_AUDIENCE and COMPASSDOCS_LICENSE_TOKEN are both set: the license endpoint is reached with the managed identity, and the token is not used.");
  }
  // Every link in email, the portal's sign-in links and OAuth redirects are
  // built from it, so without a usable address cloud mode does not start.
  const base = env.COMPASSDOCS_BASE_URL?.trim();
  if (!base) {
    fatal.push(
      "COMPASSDOCS_BASE_URL is not set. Cloud mode builds every link in email and every sign-in redirect from it: set it to the workspace's public address, e.g. https://acme.compassdocs.io."
    );
  } else {
    let u: URL | null = null;
    try {
      u = new URL(base);
    } catch {
      fatal.push("COMPASSDOCS_BASE_URL is not a valid URL: set it to the workspace's public address, e.g. https://acme.compassdocs.io.");
    }
    // Not https: fatal, except a loopback address (a developer's machine,
    // the e2e suite), which can never be a workspace's public address.
    if (u && u.protocol !== "https:") {
      const loopback = u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
      if (loopback) warnings.push(`COMPASSDOCS_BASE_URL is a plain-http loopback address (${u.origin}): fine on this machine, never for a workspace.`);
      else fatal.push(`COMPASSDOCS_BASE_URL must be an https:// address (it is ${u.protocol}//…): set it to the workspace's public address, e.g. https://acme.compassdocs.io.`);
    }
  }
  return { fatal, warnings };
}
