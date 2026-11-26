// The HTTP side of support access (1.21.4): shared by its routes.
//
// Server-only.

import "server-only";
import { NextResponse } from "next/server";
import { MAX_TOKEN_BYTES } from "./support-token";
import { SupportError } from "./support";
import { readTextCapped } from "./body-reader";
import { supportEndpointRateLimited } from "./rate-limit";
import { ipFrom } from "./audit";

/** No cache, no sniffing: what every support answer carries. */
export const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export function supportJson(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

/** A SupportError (or anything else) as the route's answer: the sentence and the code, never a stack. */
export function supportErrorResponse(e: unknown): NextResponse {
  if (e instanceof SupportError) return supportJson({ error: e.message, code: e.code }, e.status);
  console.error("[support]", e);
  return supportJson({ error: "Something went wrong.", code: "error" }, 500);
}

/** 429 when this address has asked too often, else null. */
export function supportRateLimit(req: Request): NextResponse | null {
  const wait = supportEndpointRateLimited(ipFrom(req) ?? "unknown");
  return wait ? supportJson({ error: "Too many requests. Try again shortly.", code: "rate_limited" }, 429, { "Retry-After": String(wait) }) : null;
}

/**
 * The token a request carries: the body as text/plain, or {"token": "…"} as
 * application/json; at most MAX_TOKEN_BYTES (plus the JSON around it).
 */
export async function tokenFromBody(req: Request): Promise<string | NextResponse> {
  const raw = await readTextCapped(req, MAX_TOKEN_BYTES + 256);
  if (raw === null) return supportJson({ error: "The token is too large.", code: "too_large" }, 413);
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json") {
    try {
      const o = JSON.parse(raw) as { token?: unknown };
      if (typeof o?.token === "string") return o.token;
    } catch {
      /* below */
    }
    return supportJson({ error: 'Send {"token": "<signed token>"}.', code: "malformed" }, 400);
  }
  if (type === "text/plain" || type === "") return raw.trim();
  return supportJson({ error: "Send the token as text/plain or application/json.", code: "unsupported_media_type" }, 415);
}

/** The token in `Authorization: Bearer <token>`, or null. */
export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_.-]{1,8192})\s*$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * The JSON body of an administrator's change (support decisions and
 * settings, workspace exports): refused unless it is application/json, so
 * a cross-site form (which can only send text/plain, urlencoded or
 * multipart without the browser asking first) never reaches it, whatever
 * the Origin check made of it.
 */
export async function requireJson(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return supportJson({ error: "Send application/json.", code: "unsupported_media_type" }, 415);
  const raw = await readTextCapped(req, 16 * 1024);
  if (raw === null) return supportJson({ error: "The request is too large.", code: "too_large" }, 413);
  try {
    const o = JSON.parse(raw || "{}") as unknown;
    if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
  } catch {
    /* below */
  }
  return supportJson({ error: "The body is not a JSON object.", code: "invalid" }, 400);
}
