import { NextResponse } from "next/server";
import { getAppSettings, updateAppSettings } from "@/lib/settings-store";
import { normalizeDomain, TLS_MODES, SECURE_COOKIE_MODES } from "@/lib/settings";
import type { AppSettings, TlsMode, SecureCookieMode } from "@/lib/settings";
import { hasCustomCert, storeCustomCert } from "@/lib/caddy";
import { apiGuard, credentialSaveError } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { domainState, saveDomainSettings } from "@/lib/domain-flow";

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
  if (body?.tls_email !== undefined) patch.tls_email = String(body.tls_email);
  if (body?.secure_cookies !== undefined) {
    if (!SECURE_COOKIE_MODES.includes(body.secure_cookies as SecureCookieMode)) {
      return NextResponse.json({ error: "Unknown cookie-security mode." }, { status: 400 });
    }
    patch.secure_cookies = body.secure_cookies as SecureCookieMode;
  }

  // Store a newly-pasted cert/key pair (write-only) before applying.
  const wantsCustom = (patch.tls_mode ?? (await getAppSettings()).tls_mode) === "custom";
  if (body?.tls_cert || body?.tls_key) {
    try {
      await storeCustomCert(String(body.tls_cert || ""), String(body.tls_key || ""));
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Invalid certificate." }, { status: 400 });
    }
  }
  if (wantsCustom && !(await hasCustomCert())) {
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

  const current = await getAppSettings();
  const actor = actorFrom(gate);
  const ip = ipFrom(req);
  const result = await saveDomainSettings({
    domain: patch.custom_domain ?? current.custom_domain,
    tls_mode: patch.tls_mode,
    tls_email: patch.tls_email,
    force: body?.force === true,
    actor,
    ip,
    hostHeader: req.headers.get("host"),
    via: "settings",
  });

  await audit({
    actor,
    action: "settings.domain",
    details: {
      domain: patch.custom_domain,
      tls_mode: patch.tls_mode,
      applied: result.applied,
      outcome: result.outcome,
      ...(result.remembered_fallback ? { fallback_remembered: result.remembered_fallback } : {}),
    },
    ip,
  });

  return NextResponse.json({
    ok: true,
    // The proxy took the saved config. False for a domain left pending
    // (nothing was pushed), with `check` saying why.
    applied: result.applied,
    outcome: result.outcome,
    check: result.check,
    proxyError: result.outcome === "pending" || result.applied ? undefined : result.proxyError,
    state: await currentState(),
  });
}