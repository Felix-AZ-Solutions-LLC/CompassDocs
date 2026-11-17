// Consent decision handler. Re-validates everything the consent page showed
// (the form fields are client-tamperable), then 303s back to the client's
// registered redirect URI with a single-use code — or error=access_denied.

import { NextResponse } from "next/server";
import { currentSession } from "@/lib/auth";
import { crossOriginRejection } from "@/lib/api-auth";
import { userHolds } from "@/lib/access";
import { createOAuthCode, getOAuthClient } from "@/lib/db";
import { audit, actorFrom, ipFrom } from "@/lib/audit";
import { deskDoorRefusal } from "@/lib/helpdesk/access";
import { consentTokenValid } from "@/lib/oauth-consent";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // 1.20.27 (security review M1): the one cookie-authenticated write that
  // had no Origin check. A browser declaring another origin is refused.
  const cross = await crossOriginRejection();
  if (cross) return cross;
  // The session itself (not getCurrentUser): its token binds the form's
  // anti-forgery token. One that still owes Duo, a new password or two-step
  // set-up approves nothing.
  const session = await currentSession();
  if (!session || session.duo.signIn || session.pending) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const user = session.user;

  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "");

  const client = await getOAuthClient(get("client_id"));
  const redirectUri = get("redirect_uri");
  if (!client || !client.redirect_uris.includes(redirectUri)) {
    return NextResponse.json({ error: "Invalid client or redirect URI." }, { status: 400 });
  }
  const target = new URL(redirectUri);
  const state = get("state");
  if (state) target.searchParams.set("state", state);

  // Saying no is always allowed: a forged "deny" only sends the app its own refusal.
  if (get("decision") !== "approve") {
    target.searchParams.set("error", "access_denied");
    return NextResponse.redirect(target, 303);
  }

  // 1.20.5: approving hands the app a token that reaches the desk without
  // Duo ever being asked again, so someone with desk-side access cannot
  // approve while their session owes the desk its Duo approval. (The consent
  // page sends them to the Duo step first; this is for a request that skips
  // the page.)
  const duo = await deskDoorRefusal(user);
  if (duo) return duo;

  // 1.20.27 (security review M1): an approval must come from the consent
  // page this session was shown, for exactly this client, address and
  // challenge (lib/oauth-consent). Refused before anything is redirected.
  const fields = { client_id: client.client_id, redirect_uri: redirectUri, code_challenge: get("code_challenge") };
  if (!consentTokenValid(get("consent_token"), session.token, fields)) {
    return NextResponse.json({ error: "This approval page has expired. Start connecting the app again." }, { status: 403 });
  }

  // 1.20.27 (security review H4): a connector grant is a bearer credential
  // like a personal API token, so it takes the same permission. A role
  // without account.token_create cannot get one by this door either.
  if (!(await userHolds(user, "account.token_create", { legacyMin: "viewer" }))) {
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "Your role doesn't allow connecting apps.");
    return NextResponse.redirect(target, 303);
  }

  const challenge = get("code_challenge");
  if (!challenge || (get("code_challenge_method") || "S256") !== "S256") {
    target.searchParams.set("error", "invalid_request");
    return NextResponse.redirect(target, 303);
  }

  const code = await createOAuthCode({
    clientId: client.client_id,
    userId: user.id,
    redirectUri,
    codeChallenge: challenge,
  });
  await audit({
    actor: actorFrom(user),
    action: "account.oauth_authorized",
    details: { client: client.name || client.client_id },
    ip: ipFrom(req),
  });

  target.searchParams.set("code", code);
  return NextResponse.redirect(target, 303);
}
