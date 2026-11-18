import { NextResponse } from "next/server";
import { passwordProblem } from "@/lib/password-policy";
import { needsSetup, createUser, createSession, markLogin, setSetting } from "@/lib/db";
import { hashPassword, newToken } from "@/lib/password";
import { getSessionTimeoutMinutes } from "@/lib/settings-store";
import { SESSION_COOKIE, cookieOptions, SESSION_MAX_AGE, secureCookie } from "@/lib/auth";
import { normalizeDomain, SECURE_COOKIE_MODES, TLS_MODES, validTlsEmail, type SecureCookieMode } from "@/lib/settings";
import type { TlsMode } from "@/lib/settings";
import { parseLicense } from "@/lib/license";
import { setAnthropicKey } from "@/lib/ai-config";
import { saveDomainSettings } from "@/lib/domain-flow";
import { actorFrom, ipFrom } from "@/lib/audit";
import { credentialSaveError } from "@/lib/api-auth";
import { printSetupToken, setupTokenMatches } from "@/lib/setup-token";

export const dynamic = "force-dynamic";

// First-run setup: create the initial admin account. Only works while the
// instance has no users; once set up, it refuses (409).
export async function POST(req: Request) {
  if (!(await needsSetup())) {
    return NextResponse.json({ error: "Setup has already been completed." }, { status: 409 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // 1.20.27 (security review M11): the setup token printed to the server
  // log, so only the operator can claim a fresh install (lib/setup-token).
  if (!setupTokenMatches(body?.setup_token)) {
    printSetupToken("page");
    return NextResponse.json(
      {
        error: "Enter the setup token from the server log (docker compose logs app).",
        code: "setup_token",
      },
      { status: 403 }
    );
  }

  const username = String(body?.username ?? "").trim();
  const name = String(body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const password = String(body?.password ?? "");
  const companyName = String(body?.company_name ?? "").trim();

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username)) {
    return NextResponse.json(
      { error: "Username must be 2–40 characters (letters, numbers, . _ -)." },
      { status: 400 }
    );
  }
  const pwProblem = passwordProblem(password);
  if (pwProblem) {
    return NextResponse.json(
      { error: pwProblem },
      { status: 400 }
    );
  }

  // Validate the optional license key BEFORE creating the admin, so a bad key
  // doesn't half-complete setup (the admin exists but the request errored).
  const licenseRaw = String(body?.license_key ?? "").trim();
  if (licenseRaw) {
    const { error: licErr } = parseLicense(licenseRaw);
    if (licErr) {
      return NextResponse.json({ error: `License key rejected: ${licErr}` }, { status: 400 });
    }
  }

  // 1.20.29 (review M2): the renewal email lands in the proxy config, so
  // only a plain address; refused before the admin is created.
  let tlsEmail: string | undefined;
  if (body?.tls_email !== undefined) {
    const v = validTlsEmail(String(body.tls_email));
    if (v === null) {
      return NextResponse.json(
        { error: "Enter a plain email address like admin@example.com for renewal notices, or leave it blank." },
        { status: 400 }
      );
    }
    tlsEmail = v;
  }

  // Re-check inside the write to narrow the race window.
  if (!(await needsSetup())) {
    return NextResponse.json({ error: "Setup has already been completed." }, { status: 409 });
  }

  const { hash, salt } = await hashPassword(password);
  let user;
  try {
    user = await createUser({
      username,
      name: name || username,
      email,
      role: "admin",
      passwordHash: hash,
      passwordSalt: salt,
      mustChange: false,
    });
  } catch {
    return NextResponse.json({ error: "Could not create the account." }, { status: 400 });
  }

  if (companyName) await setSetting("company_name", companyName.slice(0, 80));

  // Cookie-security choice from the wizard (defaults to "auto", which matches
  // the request protocol — so plain-HTTP setups don't hit a login loop).
  const secureMode = String(body?.secure_cookies ?? "auto") as SecureCookieMode;
  if (SECURE_COOKIE_MODES.includes(secureMode)) {
    await setSetting("secure_cookies", secureMode);
  }

  // Store the (already-validated) license key, if one was entered.
  if (licenseRaw) await setSetting("license_key", licenseRaw);

  // Optional Anthropic API key — same store the AI settings page uses
  // (write-only; changeable later under Settings → AI).
  const aiKey = String(body?.anthropic_api_key ?? "").trim();
  if (aiKey) {
    const keyErr = await credentialSaveError(() => setAnthropicKey(aiKey));
    if (keyErr) return keyErr;
  }

  // Optional domain + HTTPS from the wizard. 1.20.29: checked before the
  // proxy is switched to it (lib/domain-flow), so a name whose DNS isn't
  // visible yet waits as pending instead of taking the address the wizard
  // was opened on away. Never blocks finishing setup.
  let domainOutcome: { outcome: string; domain: string; message?: string } | null = null;
  if (body?.custom_domain !== undefined || body?.tls_mode !== undefined || body?.tls_email !== undefined) {
    const mode = TLS_MODES.includes(body?.tls_mode as TlsMode) ? (body.tls_mode as TlsMode) : undefined;
    try {
      const r = await saveDomainSettings({
        domain: String(body?.custom_domain ?? ""),
        tls_mode: mode,
        tls_email: tlsEmail,
        actor: actorFrom(user),
        ip: ipFrom(req),
        hostHeader: req.headers.get("host"),
        via: "setup",
      });
      domainOutcome = {
        outcome: r.outcome,
        domain: r.pending?.domain ?? normalizeDomain(String(body?.custom_domain ?? "")),
        message: r.outcome === "pending" ? r.pending?.last_check.message ?? r.check?.message : undefined,
      };
    } catch (e) {
      /* proxy may be unreachable during first-run; settings are saved regardless */
      console.error("[setup] domain step:", e);
    }
  }

  // Sign the new admin in immediately.
  const token = newToken();
  const expires = new Date(
    Date.now() + (await getSessionTimeoutMinutes()) * 60_000
  ).toISOString();
  await createSession(token, user.id, expires, null, req.headers.get("user-agent"), "setup");
  await markLogin(user.id);

  // A domain left pending: the wizard opens Settings → Domain & HTTPS, which
  // says why; one being verified: it waits for HTTPS, then opens the domain.
  const res = NextResponse.json({ ok: true, ...(domainOutcome ? { domain: domainOutcome } : {}) });
  res.cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_MAX_AGE, await secureCookie(req)));
  return res;
}
