// The workspace's own address (1.20.27, security review app H1 and M1).
//
// Links that arrive by email (a portal sign-in link, "a new ticket", an SLA
// warning, a survey) are built ONLY from an address an administrator
// configured, never from the Host or X-Forwarded-Host header of whatever
// request caused the mail: on an install that passes any Host through (no
// custom domain behind the bundled Caddy, port 3000 published, a load
// balancer that forwards Host), a stranger could otherwise have a genuine
// mail point at their own server.
//
// The configured address is, in order:
//   1. the custom domain (Settings → Domain & HTTPS), as https://<domain>;
//   2. COMPASSDOCS_BASE_URL, an http(s) origin set in the environment (for an
//      install behind its own proxy, or a plain-HTTP intranet address);
//   3. none: mail links are relative, the customer portal sends no sign-in
//      links, and the desk's setup page and portal settings say why.
//
// 1.21.0, cloud mode (lib/cloud): only COMPASSDOCS_BASE_URL. The platform
// owns the workspace's address and sets it there (cloud mode refuses to
// start without it); a custom domain saved before is ignored, here and in
// every other reader (originForDomain, and getAppSettings blanks it).
//
// Server-only.

import "server-only";
import { getAppSettings } from "./settings-store";
import { isCloud } from "./cloud";

/** COMPASSDOCS_BASE_URL as an origin ("https://docs.example.com"), or null when unset or not an http(s) URL. */
export function envBaseOrigin(): string | null {
  const raw = process.env.COMPASSDOCS_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The origin every link CompassDocs sends out is built from (1.20.27,
 * security review M4): mail (comments and mentions, change requests,
 * announcements, training, confirmations, newsletters, status notices…)
 * and the chat and webhook posts that carry the same links. The configured
 * address, or "" when none is, so links are relative. Never the Host or
 * X-Forwarded-Host of the request that caused the notice.
 */
export async function mailOrigin(): Promise<string> {
  return ((await workspaceOrigin()) ?? "").replace(/\/+$/, "");
}

/** The configured workspace address, or null when none is configured. */
export async function workspaceOrigin(): Promise<string | null> {
  if (isCloud()) return envBaseOrigin();
  return (await domainOrigin()) ?? envBaseOrigin();
}

/**
 * The custom domain as an origin, for the readers that link by the custom
 * domain alone and fall back their own way (the request's origin, a
 * relative link, the browser's): "https://<domain>", or null when none is
 * saved. Self-hosted, that is exactly what each of them read before 1.21.0.
 *
 * 1.21.0, cloud mode: COMPASSDOCS_BASE_URL's origin instead, always. A
 * custom_domain left in the settings of a database moved from a
 * self-hosted install is stale and is never used (review of #334).
 */
export function originForDomain(customDomain: string | null | undefined): string | null {
  if (isCloud()) return envBaseOrigin();
  const d = (customDomain ?? "").trim();
  return d ? `https://${d}` : null;
}

/** originForDomain with the saved custom_domain; null when none is saved or the settings can't be read. */
export async function domainOrigin(): Promise<string | null> {
  if (isCloud()) return envBaseOrigin();
  try {
    return originForDomain((await getAppSettings()).custom_domain);
  } catch {
    return null;
  }
}
