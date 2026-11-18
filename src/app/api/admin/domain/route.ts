import { NextResponse } from "next/server";
import { getAppSettings, updateAppSettings } from "@/lib/settings-store";
import { normalizeDomain, TLS_MODES, SECURE_COOKIE_MODES, validTlsEmail } from "@/lib/settings";
import type { AppSettings, TlsMode, SecureCookieMode } from "@/lib/settings";
import { applyProxyConfig, hasCustomCert, hasPendingCert, storeCustomCert, validateCustomCert } from "@/lib/caddy";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { domainState, saveDomainSettings, type DomainSaveOutcome } from "@/lib/domain-flow";

export const dynamic = "force-dynamic";

// Shape returned to the GUI (lib/domain-flow domainState): the certificate
// and key are write-only, so only whether one is stored.
const currentState = domainState;

export async function GET() {
  const gate = await apiGuard("admin", "workspace.domain_manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await currentState());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "workspace.domain_manage");
  if (gate instanceof NextResponse) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Validate up front so we don't half-save an invalid combination.
  const patch: Partial<AppSettings> = {};
  if (body?.custom_domain !== undefined) {
    const raw = String(body.custom_domain).trim();
    if (raw && !normalizeDomain(raw)) {
      return NextResponse.json(
        { error: "Enter a valid domain like docs.example.com (no http:// or path)." },
        { status: 400 }
      );
    }
    patch.custom_domain = raw;
  }
  if (body?.tls_mode !== undefined) {
    if (!TLS_MODES.includes(body.tls_mode as TlsMode)) {
      return NextResponse.json({ error: "Unknown TLS mode." }, { status: 400 });
    }
    patch.tls_mode = body.tls_mode as TlsMode;
  }
  if (body?.tls_email !== undefined) {
    // 1.20.29 (review M2): the email is written into the proxy config.
    const email = validTlsEmail(String(body.tls_email));
    if (email === null) {
      return NextResponse.json(
        { error: "Enter a plain email address like admin@example.com for renewal notices, or leave it blank." },
        { status: 400 }
      );
    }
    patch.tls_email = email;
  }
  if (body?.secure_cookies !== undefined) {
    if (!SECURE_COOKIE_MODES.includes(body.secure_cookies as SecureCookieMode)) {
      return NextResponse.json({ error: "Unknown cookie-security mode." }, { status: 400 });
    }
    patch.secure_cookies = body.secure_cookies as SecureCookieMode;
  }

  // A newly pasted cert/key pair (write-only). 1.20.29 (review M1): it is
  // stored by lib/domain-flow with the outcome, so a pair pasted for a
  // domain that waits for its check never replaces the live domain's.
  let cert: { cert: string; key: string } | undefined;
  if (body?.tls_cert || body?.tls_key) {
    const v = validateCustomCert(String(body.tls_cert || ""), String(body.tls_key || ""));
    if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });
    cert = v;
  }
  const current = await getAppSettings();
  const wantsCustom = (patch.tls_mode ?? current.tls_mode) === "custom";
  if (wantsCustom && !cert && !(await hasCustomCert()) && !(await hasPendingCert())) {
    return NextResponse.json(
      { error: "Bring-your-own TLS needs a certificate and private key." },
      { status: 400 }
    );
  }

  // Everything but the domain triple saves as before; the domain, its TLS
  // mode and email go through the check (1.20.29, lib/domain-flow).
  const { custom_domain: _d, tls_mode: _m, tls_email: _e, ...rest } = patch;
  if (Object.keys(rest).length) {
    const keyErr = await credentialSaveError(() => updateAppSettings(rest));
    if (keyErr) return keyErr;
  }

  const actor = actorFrom(gate);
  const ip = ipFrom(req);
  const touchesDomain = body?.custom_domain !== undefined || body?.tls_mode !== undefined || body?.tls_email !== undefined;
  let r!: DomainSaveOutcome;
  const keyErr = await credentialSaveError(async () => {
    if (touchesDomain) {
      r = await saveDomainSettings({
        domain: patch.custom_domain ?? current.custom_domain,
        tls_mode: patch.tls_mode,
        tls_email: patch.tls_email,
        cert,
        force: body?.force === true,
        actor,
        ip,
        hostHeader: req.headers.get("host"),
        via: "settings",
      });
      return;
    }
    // Nothing about the domain (review L5): a waiting domain stays as it
    // is; a pasted pair is the live domain's; the proxy is re-applied.
    if (cert) await storeCustomCert(cert.cert, cert.key);
    const a = await applyProxyConfig();
    r = { outcome: "saved", applied: a.ok, proxyError: a.ok ? undefined : a.error, pending: null, remembered_fallback: null };
  });
  if (keyErr) return keyErr;

  await audit({
    actor,
    action: "settings.domain",
    details: {
      domain: patch.custom_domain,
      tls_mode: patch.tls_mode,
      applied: r.applied,
      outcome: r.outcome,
      ...(r.remembered_fallback ? { fallback_remembered: r.remembered_fallback } : {}),
    },
    ip,
  });

  return NextResponse.json({
    ok: true,
    // The proxy took the new config. False for a domain left pending
    // (nothing was pushed), with `check` saying why; "verifying": switched,
    // HTTPS being verified, the settings follow when it answers.
    applied: r.applied,
    outcome: r.outcome,
    check: r.check,
    proxyError: r.outcome === "pending" || r.applied ? undefined : r.proxyError,
    state: await currentState(),
  });
}