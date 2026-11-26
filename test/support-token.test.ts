// Support tokens (1.21.4, lib/support-token) and their configuration
// (lib/cloud supportAccessConfig). Pure: a throwaway Ed25519 key signs,
// the clock is passed in.
//
// Covered: a valid request and grant; every refusal (another key, a payload
// or signature changed after signing, base64 that doesn't round-trip, one
// kind passed off as the other, another workspace, expired, not yet valid,
// signed in the future, the clock-skew edges, longer than 8 hours, a
// request token valid for over an hour, each missing or malformed claim,
// control characters, both or neither of request and emergency, the wrong
// version, oversized); key rotation (two keys); the configuration (off
// self-hosted, PEM and base64, never the license key, a workspace id
// required, at most three keys) and cloud mode refusing to start on a bad
// key.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/support-token.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { cloudStartupProblems, supportAccessConfig, supportAccessProblems, supportKeyDer, type SupportAccessConfig } from "../src/lib/cloud";
import { CLOCK_SKEW_S, GRANT_TYP, MAX_ACCESS_SECONDS, MAX_TOKEN_BYTES, REQUEST_TYP, verifySupportToken } from "../src/lib/support-token";

const WS = "ws_7f3a9c";
const NOW = Date.parse("2026-11-26T12:00:00Z");
const T = Math.floor(NOW / 1000);
const LICENSE_KEY = "MCowBQYDK2VwAyEA3zj2D3VLyIij/SovtpZWwY1xFrX8F6n876GPISVnxE0=";

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, spki, b64: spki.toString("base64"), pem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}
const K1 = keypair();
const K2 = keypair();
const CFG: SupportAccessConfig = { workspaceId: WS, keys: [K1.spki] };

function signWith(key: KeyObject, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims));
  return `${payload.toString("base64url")}.${sign(null, payload, key).toString("base64url")}`;
}

const STAFF = { name: "Jane Doe", email: "Jane.Doe@CompassDocs.io" };
function request(over: Record<string, unknown> = {}, key = K1.privateKey): string {
  return signWith(key, { typ: REQUEST_TYP, v: 1, jti: "req_0123456789abcdef", workspace: WS, staff: STAFF, reason: "Ticket 4411: the import stalls", level: "read_only", duration_minutes: 120, iat: T, nbf: T, exp: T + 900, ...over });
}
function grant(over: Record<string, unknown> = {}, key = K1.privateKey): string {
  return signWith(key, { typ: GRANT_TYP, v: 1, jti: "grt_0123456789abcdef", workspace: WS, staff: STAFF, reason: "Ticket 4411", level: "read_only", request: "req_0123456789abcdef", iat: T, nbf: T, exp: T + 3600, ...over });
}

function code(r: { ok: true } | { ok: false; code: string }): string {
  return r.ok ? "ok" : r.code;
}

describe("verifySupportToken: what is accepted", () => {
  test("a request token for this workspace", () => {
    const r = verifySupportToken("request", request(), CFG, NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.claims.jti, "req_0123456789abcdef");
    assert.equal(r.claims.staff.email, "jane.doe@compassdocs.io", "the email is compared in lower case");
    assert.equal(r.claims.duration_minutes, 120);
    assert.equal(r.claims.level, "read_only");
  });

  test("a grant for an approved request, and an emergency grant", () => {
    const r = verifySupportToken("grant", grant(), CFG, NOW);
    assert.equal(r.ok && r.claims.request, "req_0123456789abcdef");
    const e = verifySupportToken("grant", grant({ request: undefined, emergency: "Production outage, P1 INC-77" }), CFG, NOW);
    assert.equal(e.ok && e.claims.emergency, "Production outage, P1 INC-77");
  });

  test("the level defaults to read-only", () => {
    const r = verifySupportToken("grant", grant({ level: undefined }), CFG, NOW);
    assert.equal(r.ok && r.claims.level, "read_only");
  });

  test("rotation: any of the configured keys", () => {
    const cfg = { workspaceId: WS, keys: [K1.spki, K2.spki] };
    assert.equal(code(verifySupportToken("grant", grant({}, K2.privateKey), cfg, NOW)), "ok");
    assert.equal(code(verifySupportToken("grant", grant({}, K1.privateKey), cfg, NOW)), "ok");
  });

  test("surrounding whitespace is ignored", () => {
    assert.equal(code(verifySupportToken("grant", `  ${grant()}\n`, CFG, NOW)), "ok");
  });
});

describe("verifySupportToken: what is refused", () => {
  test("signed by another key (the license key's holder included)", () => {
    assert.equal(code(verifySupportToken("grant", grant({}, K2.privateKey), CFG, NOW)), "bad_signature");
  });

  test("a payload changed after signing", () => {
    const [body, sig] = grant().split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    claims.level = "admin";
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
    assert.equal(code(verifySupportToken("grant", forged, CFG, NOW)), "bad_signature");
  });

  test("a signature changed, cut or padded", () => {
    const [body, sig] = grant().split(".");
    const bytes = Buffer.from(sig, "base64url");
    bytes[0] ^= 1;
    assert.equal(code(verifySupportToken("grant", `${body}.${bytes.toString("base64url")}`, CFG, NOW)), "bad_signature");
    assert.equal(code(verifySupportToken("grant", `${body}.${sig.slice(0, -4)}`, CFG, NOW)), "malformed");
    assert.equal(code(verifySupportToken("grant", `${body}.${sig}AA`, CFG, NOW)), "malformed");
  });

  test("base64url that doesn't round-trip (stray bits), and shapes that aren't a token", () => {
    const [body, sig] = grant().split(".");
    const last = sig.slice(-1);
    const twiddled = sig.slice(0, -1) + (last === "A" ? "B" : "A");
    // The last character of a 64-byte signature carries 4 unused bits: a change there may decode the same.
    const r = verifySupportToken("grant", `${body}.${twiddled}`, CFG, NOW);
    assert.notEqual(code(r), "ok");
    for (const raw of ["", "abc", "a.b.c", `${body}.`, `.${sig}`, `${body}.${sig}=`, `${body} .${sig}`, 42 as unknown as string]) {
      assert.equal(code(verifySupportToken("grant", raw, CFG, NOW)), "malformed", String(raw));
    }
  });

  test("larger than the limit", () => {
    const big = grant({ reason: "x".repeat(MAX_TOKEN_BYTES) });
    assert.equal(code(verifySupportToken("grant", big, CFG, NOW)), "malformed");
  });

  test("one kind passed off as the other", () => {
    assert.equal(code(verifySupportToken("request", grant(), CFG, NOW)), "wrong_kind");
    assert.equal(code(verifySupportToken("grant", request(), CFG, NOW)), "wrong_kind");
    assert.equal(code(verifySupportToken("grant", grant({ typ: "compassdocs.license" }), CFG, NOW)), "wrong_kind");
  });

  test("another workspace, or none", () => {
    assert.equal(code(verifySupportToken("grant", grant({ workspace: "ws_other" }), CFG, NOW)), "wrong_workspace");
    assert.equal(code(verifySupportToken("grant", grant({ workspace: undefined }), CFG, NOW)), "wrong_workspace");
    assert.equal(code(verifySupportToken("grant", grant({ workspace: `${WS} ` }), CFG, NOW)), "wrong_workspace");
  });

  test("expired, and the skew on each side", () => {
    const t = grant({ nbf: T - 3600, exp: T });
    assert.equal(code(verifySupportToken("grant", t, CFG, NOW)), "ok", "inside the skew after exp");
    assert.equal(code(verifySupportToken("grant", t, CFG, NOW + (CLOCK_SKEW_S - 1) * 1000)), "ok");
    assert.equal(code(verifySupportToken("grant", t, CFG, NOW + CLOCK_SKEW_S * 1000)), "expired");
  });

  test("not yet valid, and signed in the future", () => {
    assert.equal(code(verifySupportToken("grant", grant({ nbf: T + CLOCK_SKEW_S, exp: T + 3600 }), CFG, NOW)), "ok", "within the skew");
    assert.equal(code(verifySupportToken("grant", grant({ nbf: T + CLOCK_SKEW_S + 1, exp: T + 3600 }), CFG, NOW)), "not_yet_valid");
    assert.equal(code(verifySupportToken("grant", grant({ iat: T + CLOCK_SKEW_S + 1 }), CFG, NOW)), "not_yet_valid");
  });

  test("longer than 8 hours; a request token valid for over an hour; ends before it starts", () => {
    assert.equal(code(verifySupportToken("grant", grant({ exp: T + MAX_ACCESS_SECONDS }), CFG, NOW)), "ok");
    assert.equal(code(verifySupportToken("grant", grant({ exp: T + MAX_ACCESS_SECONDS + 1 }), CFG, NOW)), "too_long");
    assert.equal(code(verifySupportToken("request", request({ exp: T + 3601 }), CFG, NOW)), "too_long");
    assert.equal(code(verifySupportToken("grant", grant({ nbf: T, exp: T }), CFG, NOW)), "invalid_claims");
  });

  test("a request's duration: 15 minutes to 8 hours, whole minutes", () => {
    for (const d of [15, 480]) assert.equal(code(verifySupportToken("request", request({ duration_minutes: d }), CFG, NOW)), "ok", String(d));
    for (const d of [14, 481, 30.5, "60", null, undefined]) assert.equal(code(verifySupportToken("request", request({ duration_minutes: d }), CFG, NOW)), "invalid_claims", String(d));
  });

  test("missing or malformed claims", () => {
    const bad: Record<string, unknown>[] = [
      { jti: "short" },
      { jti: "has spaces in it, sixteen+" },
      { jti: undefined },
      { iat: undefined },
      { exp: "soon" },
      { nbf: 1.5 },
      { staff: undefined },
      { staff: { name: "", email: "a@b.co" } },
      { staff: { name: "Jane", email: "not-an-email" } },
      { staff: { name: "Jane‮", email: "a@b.co" } },
      { staff: { name: "Jane\nEvil: yes", email: "a@b.co" } },
      { reason: "" },
      { reason: "r".repeat(501) },
      { level: "owner" },
      { v: 2 },
      { request: "bad id" },
      { request: undefined },
      { emergency: "Outage" },
      { request: undefined, emergency: "" },
    ];
    for (const over of bad) assert.equal(code(verifySupportToken("grant", grant(over), CFG, NOW)), "invalid_claims", JSON.stringify(over));
  });

  test("a payload that isn't a JSON object", () => {
    for (const p of ["[1,2]", "null", "not json", '"str"']) {
      const payload = Buffer.from(p);
      const t = `${payload.toString("base64url")}.${sign(null, payload, K1.privateKey).toString("base64url")}`;
      assert.equal(code(verifySupportToken("grant", t, CFG, NOW)), "malformed", p);
    }
  });

  test("the message never repeats the token", () => {
    const t = grant({ workspace: "ws_other" });
    const r = verifySupportToken("grant", t, CFG, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!r.message.includes(t.split(".")[1]));
  });
});

describe("configuration (lib/cloud)", () => {
  const cloud = (vars: Record<string, string | undefined>) => ({ COMPASSDOCS_CLOUD: "1", COMPASSDOCS_WORKSPACE_ID: WS, ...vars });

  test("self-hosted: never read, never a problem", () => {
    const env = { COMPASSDOCS_SUPPORT_PUBLIC_KEY: K1.b64, COMPASSDOCS_WORKSPACE_ID: WS };
    assert.equal(supportAccessConfig(env), null);
    assert.deepEqual(supportAccessProblems(env), []);
    assert.deepEqual(supportAccessProblems({ COMPASSDOCS_SUPPORT_PUBLIC_KEY: "garbage" }), []);
  });

  test("cloud mode without the key: off, no problem", () => {
    assert.equal(supportAccessConfig(cloud({})), null);
    assert.deepEqual(supportAccessProblems(cloud({})), []);
  });

  test("base64 SPKI and PEM; two keys for rotation", () => {
    assert.equal(supportAccessConfig(cloud({ COMPASSDOCS_SUPPORT_PUBLIC_KEY: K1.b64 }))?.keys.length, 1);
    assert.ok(supportAccessConfig(cloud({ COMPASSDOCS_SUPPORT_PUBLIC_KEY: K1.pem }))?.keys[0].equals(K1.spki));
    const two = supportAccessConfig(cloud({ COMPASSDOCS_SUPPORT_PUBLIC_KEY: `${K1.b64}, ${K2.b64}` }));
    assert.equal(two?.keys.length, 2);
    assert.equal(two?.workspaceId, WS);
  });

  test("refused: not an Ed25519 key, the license key, no workspace id, too many keys", () => {
    const rsa = (generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    for (const [key, words] of [
      ["not-a-key", "not an Ed25519 public key"],
      [rsa, "not an Ed25519 public key"],
      [LICENSE_KEY, "is the license key"],
    ] as const) {
      const env = cloud({ COMPASSDOCS_SUPPORT_PUBLIC_KEY: key });
      assert.equal(supportAccessConfig(env), null, words);
      assert.match(supportAccessProblems(env).join(" "), new RegExp(words));
      assert.match(cloudStartupProblems({ ...env, COMPASSDOCS_SECRET_KEY: "a".repeat(64), DATABASE_URL: "postgres://x/y", COMPASSDOCS_BASE_URL: "https://ws.example" }).fatal.join(" "), new RegExp(words));
    }
    assert.match(supportAccessProblems(cloud({ COMPASSDOCS_SUPPORT_PUBLIC_KEY: K1.b64, COMPASSDOCS_WORKSPACE_ID: "" })).join(" "), /COMPASSDOCS_WORKSPACE_ID is not set/);
    assert.match(supportAccessProblems(cloud({ COMPASSDOCS_SUPPORT_PUBLIC_KEY: [K1.b64, K2.b64, K1.b64, K2.b64].join(",") })).join(" "), /at most 3/);
    assert.equal(supportKeyDer(LICENSE_KEY)?.length, 44, "the license key is an Ed25519 key: refused by value, not by shape");
  });
});
