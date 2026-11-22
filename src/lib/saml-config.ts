// Configuration for enterprise SAML 2.0 single sign-on (generic IdP: Okta,
// OneLogin, Google Workspace, ADFS, Entra SAML apps, …). Lives in the core so
// settings survive edition switches and the admin UI can manage them; the
// login flow itself is implemented in the enterprise overlay (/api/ee/saml/*).
//
// SAML shares the "sso" license entitlement with OIDC — the portal sells it as
// "SSO (OIDC/SAML)". The IdP signing certificate is public-key material, not a
// secret, so nothing here needs sealing. Server-only.

import { getSetting, setSetting } from "./db";
import type { Role } from "./types";

const KEYS = {
  enabled: "saml_enabled",
  idpSsoUrl: "saml_idp_sso_url",
  idpIssuer: "saml_idp_issuer",
  idpCert: "saml_idp_cert",
  autoProvision: "saml_auto_provision",
  defaultRole: "saml_default_role",
  allowedDomains: "saml_allowed_domains",
  buttonLabel: "saml_button_label",
} as const;

const ROLES: Role[] = ["viewer", "editor", "approver", "admin"];

export interface SamlConfig {
  enabled: boolean;
  /** IdP single sign-on URL (HTTP-Redirect binding endpoint). */
  idpSsoUrl: string;
  /** IdP entity ID (issuer) — must match the <Issuer> in responses. */
  idpIssuer: string;
  /** IdP X.509 signing certificate, PEM or bare base64. */
  idpCert: string;
  /** Create a CompassDocs account on first SSO sign-in (default on). */
  autoProvision: boolean;
  /** Role given to auto-provisioned accounts (default viewer). */
  defaultRole: Role;
  /** Optional comma-separated email-domain allowlist (empty = any). */
  allowedDomains: string[];
  /** Login-page button label (default "Single sign-on (SAML)"). */
  buttonLabel: string;
}

/** The SP entity ID / metadata URL and ACS URL, derived from the app origin. */
export function samlSpUrls(origin: string): { entityId: string; acs: string; metadata: string } {
  const base = origin.replace(/\/+$/, "");
  return {
    entityId: `${base}/api/ee/saml/metadata`,
    acs: `${base}/api/ee/saml/acs`,
    metadata: `${base}/api/ee/saml/metadata`,
  };
}

/** Normalize a pasted certificate: strip PEM armor and whitespace. */
export function samlCertBody(cert: string): string {
  return cert
    .replace(/-----(BEGIN|END)[^-]+-----/g, "")
    .replace(/\s+/g, "");
}

/** Configured completely enough for the login flow to run. */
export function samlConfigured(cfg: SamlConfig): boolean {
  return Boolean(cfg.enabled && cfg.idpSsoUrl && cfg.idpIssuer && samlCertBody(cfg.idpCert));
}

export async function getSamlConfig(): Promise<SamlConfig> {
  const [enabled, ssoUrl, issuer, cert, autoProv, role, domains, label] = await Promise.all([
    getSetting(KEYS.enabled),
    getSetting(KEYS.idpSsoUrl),
    getSetting(KEYS.idpIssuer),
    getSetting(KEYS.idpCert),
    getSetting(KEYS.autoProvision),
    getSetting(KEYS.defaultRole),
    getSetting(KEYS.allowedDomains),
    getSetting(KEYS.buttonLabel),
  ]);
  return {
    enabled: enabled === "1",
    idpSsoUrl: ssoUrl?.trim() || "",
    idpIssuer: issuer?.trim() || "",
    idpCert: cert || "",
    autoProvision: autoProv !== "0",
    defaultRole: ROLES.includes(role as Role) ? (role as Role) : "viewer",
    allowedDomains: (domains || "")
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
    buttonLabel: label?.trim() || "Single sign-on (SAML)",
  };
}

export async function updateSamlConfig(patch: {
  enabled?: boolean;
  idpSsoUrl?: string;
  idpIssuer?: string;
  idpCert?: string;
  autoProvision?: boolean;
  defaultRole?: Role;
  allowedDomains?: string;
  buttonLabel?: string;
}): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (patch.enabled !== undefined) jobs.push(setSetting(KEYS.enabled, patch.enabled ? "1" : "0"));
  if (patch.idpSsoUrl !== undefined) jobs.push(setSetting(KEYS.idpSsoUrl, patch.idpSsoUrl.trim()));
  if (patch.idpIssuer !== undefined) jobs.push(setSetting(KEYS.idpIssuer, patch.idpIssuer.trim()));
  if (patch.idpCert !== undefined) jobs.push(setSetting(KEYS.idpCert, patch.idpCert.trim()));
  if (patch.autoProvision !== undefined)
    jobs.push(setSetting(KEYS.autoProvision, patch.autoProvision ? "1" : "0"));
  if (patch.defaultRole !== undefined && ROLES.includes(patch.defaultRole))
    jobs.push(setSetting(KEYS.defaultRole, patch.defaultRole));
  if (patch.allowedDomains !== undefined)
    jobs.push(setSetting(KEYS.allowedDomains, patch.allowedDomains));
  if (patch.buttonLabel !== undefined) jobs.push(setSetting(KEYS.buttonLabel, patch.buttonLabel.trim()));
  await Promise.all(jobs);
}

/**
 * Parse an IdP metadata XML document into the three fields we need. Accepts
 * the document an admin downloads from Okta/Google/ADFS/etc. Uses plain
 * string scanning (no XML parser): the input is admin-supplied configuration,
 * and we only need three well-known values out of it.
 */
export function parseIdpMetadata(xml: string): {
  idpIssuer: string;
  idpSsoUrl: string;
  idpCert: string;
} | null {
  const issuer = /entityID="([^"]+)"/.exec(xml)?.[1] ?? "";
  // Tag by tag, so no pattern rescans the document from every "<" (the old
  // whole-document patterns were quadratic on a run of unclosed tags).
  // First HTTP-Redirect SingleSignOnService location (POST fallback), in
  // either attribute order.
  const ssoTags = (xml.match(/<[^<>]*>/g) ?? []).filter((t) => t.includes("SingleSignOnService"));
  // \sLocation, so a ResponseLocation="…" attribute is never read as it.
  const location = (t: string | undefined) => (t ? /\sLocation="([^"]+)"/.exec(t)?.[1] ?? "" : "");
  const redirect = location(ssoTags.find((t) => t.includes("HTTP-Redirect")));
  const post = location(ssoTags.find((t) => t.includes("HTTP-POST")));
  // The first certificate: its opening tag, then the first closing tag after it.
  const open = /<(?:[a-zA-Z0-9]+:)?X509Certificate[^<>]*>/.exec(xml);
  let cert: string | undefined;
  if (open) {
    const close = /<\/(?:[a-zA-Z0-9]+:)?X509Certificate>/g;
    close.lastIndex = open.index + open[0].length;
    const end = close.exec(xml);
    if (end) cert = xml.slice(open.index + open[0].length, end.index);
  }
  const ssoUrl = redirect || post;
  if (!issuer || !ssoUrl || !cert) return null;
  return { idpIssuer: issuer, idpSsoUrl: ssoUrl, idpCert: cert.replace(/\s+/g, "") };
}
