// Settings → Sign-in security (1.20.27).
//   GET    → { two_step, session_max_days, credentials: [...] }
//   PATCH  { two_step?, session_max_days? }   (workspace.settings_manage; audited)
//   DELETE ?kind=token&id=<token id> | ?kind=connector&id=<client id>&user=<user id>
//          revokes any account's personal token or connector grant
//          (user.reset_password; audited against the account).

import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { adminDeleteApiToken, getUserById, listAllBearerCredentials, revokeOAuthGrant, setSetting } from "@/lib/db";
import { getSignInSecurity } from "@/lib/sign-in-security";
import {
  asTwoStepScope,
  clampSessionMaxDays,
  SESSION_MAX_DAYS_MAX,
  SESSION_MAX_DAYS_MIN,
  SIGN_IN_SECURITY_KEYS as K,
  TWO_STEP_SCOPES,
} from "@/lib/sign-in-security-shared";

export const dynamic = "force-dynamic";

async function view() {
  const sec = await getSignInSecurity();
  return {
    two_step: sec.twoStep,
    session_max_days: sec.sessionMaxDays,
    credentials: await listAllBearerCredentials(),
  };
}

export async function GET() {
  const gate = await apiGuard("admin", "workspace.settings_manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await view());
}

export async function PATCH(req: Request) {
  const gate = await apiGuard("admin", "workspace.settings_manage");
  if (gate instanceof NextResponse) return gate;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const before = await getSignInSecurity();
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  if (body?.two_step !== undefined) {
    if (!TWO_STEP_SCOPES.includes(body.two_step)) {
      return NextResponse.json({ error: "Choose who must use two-step sign-in." }, { status: 400 });
    }
    const to = asTwoStepScope(body.two_step);
    if (to !== before.twoStep) {
      await setSetting(K.twoStep, to);
      changed.two_step = { from: before.twoStep, to };
    }
  }
  if (body?.session_max_days !== undefined) {
    const n = Number(body.session_max_days);
    // The form checks the same range (STYLEGUIDE §Forms): never clamp and say "saved".
    if (!Number.isInteger(n) || n < SESSION_MAX_DAYS_MIN || n > SESSION_MAX_DAYS_MAX) {
      return NextResponse.json({ error: `A session lasts from ${SESSION_MAX_DAYS_MIN} to ${SESSION_MAX_DAYS_MAX} days.` }, { status: 400 });
    }
    const to = clampSessionMaxDays(n);
    if (to !== before.sessionMaxDays) {
      await setSetting(K.sessionMaxDays, String(to));
      changed.session_max_days = { from: before.sessionMaxDays, to };
    }
  }
  if (Object.keys(changed).length) {
    await audit({ actor: actorFrom(gate), action: "settings.sign_in_security", details: changed, ip: ipFrom(req) });
  }
  return NextResponse.json({ ok: true, ...(await view()) });
}

export async function DELETE(req: Request) {
  const gate = await apiGuard("admin", "user.reset_password");
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const id = url.searchParams.get("id") || "";
  if (kind === "token") {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const gone = await adminDeleteApiToken(n);
    if (!gone) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await audit({
      actor: actorFrom(gate),
      action: "user.credential_revoked",
      targetType: "user",
      targetId: gone.user_id,
      targetLabel: gone.username,
      details: { kind: "api_token", name: gone.name },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true });
  }
  if (kind === "connector") {
    const userId = Number(url.searchParams.get("user"));
    const user = Number.isInteger(userId) && userId > 0 ? await getUserById(userId) : undefined;
    if (!user || !id || !(await revokeOAuthGrant(user.id, id))) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await audit({
      actor: actorFrom(gate),
      action: "user.credential_revoked",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.username,
      details: { kind: "connector", client_id: id },
      ip: ipFrom(req),
    });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Say what to revoke." }, { status: 400 });
}
