// POST /api/admin/sso/remove-passwords   "Remove local passwords" (1.20.27,
// security review H1). In a workspace where SSO only is on, clear the
// password of every account except the break-glass accounts, so a leftover
// or phished password can never sign in again. Each cleared account's API
// tokens, app connections and password sessions go too. Refused unless SSO
// only is in force and at least one break-glass account is an active
// administrator with a password (otherwise nobody could get in to mend a
// broken identity provider). Audited with the accounts it cleared.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { apiGuard } from "@/lib/api-auth";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { SESSION_COOKIE } from "@/lib/auth";
import { featureEnabled } from "@/lib/ee";
import { removeLocalPasswords } from "@/lib/db";
import { signInSetup } from "@/lib/sign-in-routing";
import { breakGlassIds, usableBreakGlass } from "@/lib/sign-in-security";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await apiGuard("admin", "identity.sso_manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await featureEnabled("sso"))) {
    return NextResponse.json({ error: "Your license doesn't include single sign-on." }, { status: 402 });
  }
  if (!(await signInSetup()).ssoOnly) {
    return NextResponse.json({ error: "Turn on SSO only (and save) before removing local passwords." }, { status: 409 });
  }
  const keep = await breakGlassIds();
  if ((await usableBreakGlass(keep)).length === 0) {
    return NextResponse.json(
      { error: "Name at least one break-glass account first: an active administrator with a password, who can still sign in if single sign-on fails." },
      { status: 409 }
    );
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const cleared = await removeLocalPasswords(keep, token);
  await audit({
    actor: actorFrom(gate),
    action: "user.passwords_removed",
    details: {
      count: cleared.length,
      usernames: cleared.slice(0, 50).map((u) => u.username),
      kept_break_glass: keep,
    },
    ip: ipFrom(req),
  });
  return NextResponse.json({ ok: true, removed: cleared.length });
}
