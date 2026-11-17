// Two-factor enrollment lifecycle, all for the signed-in user:
//   POST   {action:"setup"}                → pending secret + otpauth QR
//   POST   {action:"enable", code}         → verify code, activate, return recovery codes (once)
//   POST   {action:"disable", code}        → verify code (or recovery code), deactivate
// The secret only becomes enforced at login after "enable" proves the
// authenticator actually works — no locking yourself out with a bad scan.

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { apiGuardAllowing } from "@/lib/api-auth";
import { pairRetryAfter, recordLoginSuccess, recordPairFailure } from "@/lib/login-guard";
import { twoStepRequiredFor } from "@/lib/sign-in-security";
import {
  setPendingTotpSecret,
  getTotpState,
  enableTotp,
  disableTotp,
  consumeRecoveryCode,
} from "@/lib/db";
import {
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
  generateRecoveryCodes,
} from "@/lib/totp";
import { getAppSettings } from "@/lib/settings-store";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

// 1.20.27: a session that owes two-step set-up ("Require two-step sign-in")
// reaches these routes and nothing else (lib/api-auth apiGuardAllowing).
export async function GET() {
  const gate = await apiGuardAllowing("two_step", "viewer", "account.twofa_manage");
  if (gate instanceof NextResponse) return gate;
  const state = await getTotpState((gate as SessionUser).id);
  return NextResponse.json({
    enabled: Boolean(state?.enabled),
    recovery_left: state?.enabled ? state.recovery_left : 0,
    required: await requiredFor(gate as SessionUser),
  });
}

/** Does "Require two-step sign-in" cover this person (so they may not turn it off)? */
async function requiredFor(user: SessionUser): Promise<boolean> {
  return twoStepRequiredFor(user).catch(() => true);
}

export async function POST(req: Request) {
  const gate = await apiGuardAllowing("two_step", "viewer", "account.twofa_manage");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = String(body?.action ?? "");
  const state = await getTotpState(user.id);

  if (action === "setup") {
    if (state?.enabled) {
      return NextResponse.json({ error: "Two-factor auth is already enabled." }, { status: 400 });
    }
    const secret = generateTotpSecret();
    await setPendingTotpSecret(user.id, secret);
    const issuer = (await getAppSettings()).company_name || "CompassDocs";
    const uri = otpauthUri(secret, user.username, issuer);
    return NextResponse.json({
      secret,
      otpauth: uri,
      qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }),
    });
  }

  if (action === "enable") {
    if (state?.enabled) {
      return NextResponse.json({ error: "Two-factor auth is already enabled." }, { status: 400 });
    }
    if (!state?.secret) {
      return NextResponse.json({ error: "Run setup first." }, { status: 400 });
    }
    if (!verifyTotp(state.secret, String(body?.code ?? ""))) {
      return NextResponse.json({ error: "That code didn't match — try again." }, { status: 400 });
    }
    const codes = generateRecoveryCodes();
    await enableTotp(
      user.id,
      codes.map((c) => createHash("sha256").update(c).digest("hex"))
    );
    await audit({ actor: actorFrom(user), action: "auth.2fa_enabled", ip: ipFrom(req) });
    // The plaintext recovery codes exist only in this response.
    return NextResponse.json({ ok: true, recovery_codes: codes });
  }

  if (action === "disable") {
    if (!state?.enabled || !state.secret) {
      return NextResponse.json({ error: "Two-factor auth isn't enabled." }, { status: 400 });
    }
    // 1.20.27 (security review H3): the workspace requires it of this person.
    if (await requiredFor(user)) {
      return NextResponse.json(
        { error: "Your workspace requires two-step sign-in for your account, so it can't be turned off. An administrator can reset it if you lose your authenticator." },
        { status: 403 }
      );
    }
    // 1.20.27 (security review, Low): the code is an oracle like a password,
    // so it is throttled the same way (5 tries per account and address).
    const ip = ipFrom(req) || "unknown";
    const wait = pairRetryAfter(user.username, ip);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60);
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
        { status: 429, headers: { "Retry-After": String(wait) } }
      );
    }
    recordPairFailure(user.username, ip);
    const code = String(body?.code ?? "").trim();
    let ok = verifyTotp(state.secret, code);
    if (!ok) {
      const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, "");
      const pretty = `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`;
      ok =
        normalized.length === 8 &&
        (await consumeRecoveryCode(user.id, createHash("sha256").update(pretty).digest("hex")));
    }
    if (!ok) {
      return NextResponse.json({ error: "Enter a valid code to turn 2FA off." }, { status: 400 });
    }
    recordLoginSuccess(user.username, ip);
    await disableTotp(user.id);
    await audit({ actor: actorFrom(user), action: "auth.2fa_disabled", ip: ipFrom(req) });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
