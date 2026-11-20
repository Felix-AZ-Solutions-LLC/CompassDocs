import { NextResponse } from "next/server";
import { login, resolveSignInAccount, setDarkStyleCookie, IDENTIFIER_MAX, SESSION_COOKIE, cookieOptions, SESSION_MAX_AGE, secureCookie } from "@/lib/auth";
import { knownSignInAddress } from "@/lib/db";
import { PasswordBusyError } from "@/lib/password";
import { audit, ipFrom } from "@/lib/audit";
import { metric } from "@/lib/metrics";
import { beginLoginAttempt, refundLoginAttempt } from "@/lib/login-guard";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Login CSRF: a browser declaring a foreign Origin can't start a session.
  const { crossOriginRejection } = await import("@/lib/api-auth");
  const cross = await crossOriginRejection();
  if (cross) return cross;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  // `username` is the field's name for compatibility; since 1.16.0 it may be
  // an email (lib/auth resolveSignInAccount).
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");
  const totpCode = typeof body?.totp_code === "string" ? body.totp_code : undefined;
  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }
  // Longer than any email can be: refused before the throttle, the account
  // read and the audit log, on its length alone.
  if (username.length > IDENTIFIER_MAX) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 400 });
  }

  const ip = ipFrom(req) || "unknown";

  // 1.20.27 (second review M1): the throttle's budget is the account's,
  // whichever of its names was typed, and whether this address has signed
  // that account in before comes from the database (lib/login-guard). Both
  // are read first; the attempt is then checked and counted in one
  // synchronous step, and given back below when it did not fail: counted
  // after an await, a burst sent at once all passed the check. An unknown
  // identifier's budget is the typed text's, so a lock never says which
  // account, if any, an email belongs to.
  const record = await resolveSignInAccount(username);
  const known = record ? await knownSignInAddress(record.id, ip) : false;
  const attempt = beginLoginAttempt(username, ip, { account: record?.id ?? null, known });
  if (attempt.wait > 0) {
    const wait = attempt.wait;
    return NextResponse.json(
      {
        error:
          wait < 60
            ? `Too many attempts. Try again in ${wait} second${wait === 1 ? "" : "s"}.`
            : `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? "s" : ""}.`,
      },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
  }
  // An address this account signs in from is never refused by the locks, only slowed (M1).
  if (attempt.slowMs) await new Promise((r) => setTimeout(r, attempt.slowMs));

  let result: Awaited<ReturnType<typeof login>>;
  try {
    result = await login(username, password, totpCode, { ip, userAgent: req.headers.get("user-agent") }, { record });
  } catch (err) {
    // A database error, or too many password checks at once (lib/password, second review M2), is not a wrong password.
    refundLoginAttempt(attempt, false);
    if (err instanceof PasswordBusyError) {
      return NextResponse.json({ error: err.message, code: "busy" }, { status: 503, headers: { "Retry-After": String(err.retryAfter) } });
    }
    throw err;
  }
  if (!result || "refused" in result) {
    metric("login_failure");
    const refused = result && "refused" in result ? result.refused : null;
    await audit({
      actor: { name: username },
      action: "auth.login_failed",
      targetType: "user",
      targetLabel: username,
      ...(refused ? { details: { reason: refused } } : {}),
      ip,
    });
    if (attempt.lockEngaged) {
      await audit({
        actor: { name: username },
        action: "auth.lockout",
        targetType: "user",
        targetLabel: username,
        // 1.20.27: "account" when the identifier's own budget (whatever the address) began its delays.
        details: attempt.identLockEngaged ? { scope: "account" } : { minutes: 15 },
        ip,
      });
    }
    // 1.20.27 (security review H1, M2): "SSO only" refuses every password
    // but a break-glass account's with one answer, whatever was typed; an
    // expired temporary password is named only to someone who typed it.
    if (refused === "sso_only") {
      return NextResponse.json(
        { error: "This workspace signs in with single sign-on. Only its break-glass accounts can use a password.", code: "sso_only" },
        { status: 403 }
      );
    }
    if (refused === "temp_expired") {
      return NextResponse.json(
        { error: "This temporary password has expired. Ask an administrator to reset it again.", code: "temp_password_expired" },
        { status: 401 }
      );
    }
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  if ("totp_required" in result) {
    // Password was right. Ask for (or re-ask after a wrong) authenticator code;
    // a wrong code keeps its count so codes can't be brute-forced, and the
    // first step, with no code yet, gives its count back.
    if (totpCode) {
      // A wrong second factor is a failed sign-in on the record too (1.16.0),
      // and so is the lockout it engages.
      await audit({
        actor: { name: username },
        action: "auth.login_failed",
        targetType: "user",
        targetLabel: username,
        details: { stage: "two_factor" },
        ip,
      });
      if (attempt.lockEngaged) {
        await audit({
          actor: { name: username },
          action: "auth.lockout",
          targetType: "user",
          targetLabel: username,
          details: { minutes: 15, stage: "two_factor" },
          ip,
        });
      }
    } else {
      refundLoginAttempt(attempt, false);
    }
    return NextResponse.json(
      { totp_required: true, error: totpCode ? "That code didn't work — try again." : undefined },
      { status: 401 }
    );
  }

  metric("login_success");
  refundLoginAttempt(attempt, true);
  await audit({
    actor: { id: result.user.id, name: result.user.name || result.user.username, role: result.user.role },
    action: "auth.login",
    ip,
  });
  // 1.20.27 (security review H1): a password sign-in while "SSO only" is on
  // is a break-glass account's, and every one is on the record.
  if (result.breakGlass) {
    await audit({
      actor: { id: result.user.id, name: result.user.name || result.user.username, role: result.user.role },
      action: "auth.break_glass_login",
      targetType: "user",
      targetId: result.user.id,
      targetLabel: result.user.username,
      ip,
    });
  }

  const res = NextResponse.json({
    ok: true,
    must_change_password: result.user.must_change_password === 1,
  });
  const secure = await secureCookie(req);
  res.cookies.set(SESSION_COOKIE, result.token, cookieOptions(SESSION_MAX_AGE, secure));
  // 1.20.35: the account's dark style comes along, so the first page after
  // signing in on a new browser is already in it (lib/dark-style).
  setDarkStyleCookie(res, result.user, secure);
  return res;
}
