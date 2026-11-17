// The connector consent page's anti-forgery token (1.20.27, security review M1).
//
// /oauth/authorize renders the Approve form with a token bound to the
// signed-in session and to exactly what the page showed (the client, its
// redirect address and the PKCE challenge); /api/oauth/approve refuses a
// decision without a matching one. A page on another site (or a sibling
// subdomain, where the SameSite=Lax cookie is still sent) cannot read the
// token, so it cannot submit an approval for someone. Stateless: an HMAC
// under a key derived from the master key, valid for 15 minutes.
//
// Server-only.

import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getMasterKey } from "./secretbox";

const TTL_MS = 15 * 60 * 1000;

export interface ConsentFields {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

function mac(expires: number, sessionToken: string, f: ConsentFields): string {
  const key = createHmac("sha256", getMasterKey()).update("compassdocs-oauth-consent-v1").digest();
  const session = createHash("sha256").update(sessionToken).digest("hex");
  return createHmac("sha256", key)
    .update([String(expires), session, f.client_id, f.redirect_uri, f.code_challenge].join("\n"))
    .digest("base64url");
}

/** The token the consent page puts in its form. */
export function consentToken(sessionToken: string, f: ConsentFields, now = Date.now()): string {
  const expires = now + TTL_MS;
  return `${expires}.${mac(expires, sessionToken, f)}`;
}

/** Does `token` belong to this session and these fields, and is it still fresh? */
export function consentTokenValid(token: unknown, sessionToken: string, f: ConsentFields, now = Date.now()): boolean {
  if (typeof token !== "string" || token.length > 200 || !sessionToken) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expires = Number(token.slice(0, dot));
  if (!Number.isFinite(expires) || expires < now || expires > now + TTL_MS) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(mac(expires, sessionToken, f));
  return given.length === want.length && timingSafeEqual(given, want);
}
