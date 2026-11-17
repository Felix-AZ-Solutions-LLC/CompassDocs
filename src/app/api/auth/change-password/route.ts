import { NextResponse } from "next/server";
import { passwordProblem } from "@/lib/password-policy";
import { currentSession } from "@/lib/auth";
import { crossOriginRejection } from "@/lib/api-auth";
import { deleteOtherSessions, getUserByUsername, revokeUserBearerCredentials, setUserPassword } from "@/lib/db";
import { hashPassword, verifyPassword, PasswordBusyError } from "@/lib/password";
import { actorFrom, audit, ipFrom } from "@/lib/audit";
import { pairRetryAfter, recordLoginSuccess, recordPairFailure } from "@/lib/login-guard";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // 1.20.27 (security review M1 sweep): a cookie-authenticated write refuses a foreign Origin like the rest.
  const cross = await crossOriginRejection();
  if (cross) return cross;
  // 1.20.27: read the session itself, not getCurrentUser: a session that
  // owes this very change (must_change_password) or two-step set-up must
  // still reach it. A session still owing its Duo approval may not.
  const session = await currentSession();
  if (!session || session.duo.signIn) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const sessionUser = session.user;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const currentPassword = String(body?.currentPassword ?? "");
  const newPassword = String(body?.newPassword ?? "");
  const pwProblem = passwordProblem(newPassword);
  if (pwProblem) {
    return NextResponse.json({ error: `New ${pwProblem.charAt(0).toLowerCase()}${pwProblem.slice(1)}` }, { status: 400 });
  }

  const record = await getUserByUsername(sessionUser.username);
  if (!record || !record.password_hash || !record.password_salt) {
    return NextResponse.json({ error: "Account cannot change password here." }, { status: 400 });
  }
  // The current password is an oracle like the sign-in form's: throttled per
  // username and address, as the typed signature is (lib/login-guard). No
  // await between the check and the count, so a burst can't all pass it.
  const ip = ipFrom(req) || "unknown";
  const wait = pairRetryAfter(sessionUser.username, ip);
  if (wait > 0) {
    const minutes = Math.ceil(wait / 60);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
  }
  // Counted before the (asynchronous) check, given back when it passes.
  const lockEngaged = recordPairFailure(sessionUser.username, ip);
  let matches: boolean;
  try {
    matches = await verifyPassword(currentPassword, record.password_hash, record.password_salt);
  } catch (e) {
    // 1.20.27 (second review M2): too many password checks at once. The attempt keeps its count
    // (clearing the pair here would let a flood reset it).
    if (e instanceof PasswordBusyError) {
      return NextResponse.json({ error: e.message, code: "busy" }, { status: 503, headers: { "Retry-After": String(e.retryAfter) } });
    }
    throw e;
  }
  if (!matches) {
    await audit({
      actor: actorFrom(sessionUser),
      action: "auth.login_failed",
      targetType: "user",
      targetId: record.id,
      targetLabel: record.username,
      details: { via: "change_password" },
      ip,
    });
    if (lockEngaged) {
      await audit({
        actor: actorFrom(sessionUser),
        action: "auth.lockout",
        targetType: "user",
        targetId: record.id,
        targetLabel: record.username,
        details: { minutes: 15, via: "change_password" },
        ip,
      });
    }
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  }
  recordLoginSuccess(sessionUser.username, ip);

  const { hash, salt } = await hashPassword(newPassword);
  await setUserPassword(record.id, hash, salt, false);
  // 1.20.27 (security review H4): a changed password ends everything the
  // old one could have minted: API tokens, connector grants, and every
  // other session. This session stays signed in.
  const revoked = await revokeUserBearerCredentials(record.id);
  const signedOut = await deleteOtherSessions(record.id, session.token);
  await audit({
    actor: actorFrom(sessionUser),
    action: "auth.password_changed",
    targetType: "user",
    targetId: record.id,
    targetLabel: record.username,
    details: { forced: record.must_change_password === 1, ...revoked, other_sessions: signedOut },
    ip,
  });
  return NextResponse.json({ ok: true, revoked: { ...revoked, other_sessions: signedOut } });
}
