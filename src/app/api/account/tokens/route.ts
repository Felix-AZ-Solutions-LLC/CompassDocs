import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/api-auth";
import { API_TOKEN_DAYS, API_TOKEN_DEFAULT_DAYS, createApiToken, listApiTokens } from "@/lib/db";
import { mayMintForever } from "@/lib/sign-in-security";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { deskDoorRefusal } from "@/lib/helpdesk/access";
import type { SessionUser } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await apiGuard("viewer", "account.token_read");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({
    tokens: await listApiTokens((gate as SessionUser).id),
    expiry: { days: API_TOKEN_DAYS, default_days: API_TOKEN_DEFAULT_DAYS, never_allowed: await mayMintForever(gate as SessionUser) },
  });
}

export async function POST(req: Request) {
  const gate = await apiGuard("viewer", "account.token_create");
  if (gate instanceof NextResponse) return gate;
  const user = gate as SessionUser;
  // 1.20.5: a token outlives the session and reaches the desk through the
  // API and the connector, where Duo is never asked. So someone with
  // desk-side access cannot mint one while their session owes the desk its
  // Duo approval. Everyone else is unaffected.
  const duo = await deskDoorRefusal(user);
  if (duo) return duo;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const scopes = Array.isArray(body?.scopes)
    ? body.scopes.map(String)
    : ["read", "write"]; // pre-scope clients (and MCP setup) keep full access
  // 1.20.27 (security review H4): every new token expires, 90 days unless
  // another of API_TOKEN_DAYS is chosen; "never" (null) only for those who
  // may (mayMintForever). A client that sends nothing gets the default.
  let days: number | null = API_TOKEN_DEFAULT_DAYS;
  if (body?.expires_in_days === null || body?.expires_in_days === "never") {
    if (!(await mayMintForever(user))) {
      return NextResponse.json({ error: "Only administrators can create a token that never expires." }, { status: 403 });
    }
    days = null;
  } else if (body?.expires_in_days !== undefined) {
    const n = Number(body.expires_in_days);
    if (!(API_TOKEN_DAYS as readonly number[]).includes(n)) {
      return NextResponse.json({ error: `A token lasts ${API_TOKEN_DAYS.join(", ")} days.` }, { status: 400 });
    }
    days = n;
  }
  const { token, record } = await createApiToken(user.id, String(body?.name ?? ""), scopes, days);
  await audit({
    actor: actorFrom(user),
    action: "account.token_created",
    details: { name: record.name, scopes: record.scopes, expires_at: record.expires_at },
    ip: ipFrom(req),
  });
  // The raw token appears in this response ONLY — it is never retrievable again.
  return NextResponse.json({ token, record }, { status: 201 });
}
