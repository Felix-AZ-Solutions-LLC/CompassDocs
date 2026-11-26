// The first-run setup token (1.20.27, security review M11).
//
// A fresh install with no accounts is claimed by whoever completes /setup
// first. On a server reachable from the internet that could be a stranger,
// so setup now also asks for a token only the operator can read: it is
// printed to the server log (`docker compose logs app`) at start-up and
// whenever the setup page is opened, and /api/setup refuses without it.
//
// The token is derived from the workspace's master key (lib/secretbox:
// COMPASSDOCS_SECRET_KEY or the key file on the uploads volume), so every
// instance and every restart print the same one and nothing is stored.
// COMPASSDOCS_SETUP_TOKEN sets it explicitly (automated installs). It is
// useless once the first account exists. A headless install
// (COMPASSDOCS_ADMIN_USER / _PASSWORD) never runs setup at all.
//
// Server-only.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getMasterKey } from "./secretbox";
import { logEvent } from "./log";
import { isCloud } from "./cloud";

/** The token, as the operator types it: 4 groups of 5 letters and digits. */
export function setupToken(): string {
  const preset = process.env.COMPASSDOCS_SETUP_TOKEN?.trim();
  if (preset) return preset;
  const raw = createHmac("sha256", getMasterKey()).update("compassdocs-first-run-setup-v1").digest();
  // Crockford-style base32 without look-alikes (no I, L, O, U).
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet[raw[i] % 32];
  return out.match(/.{5}/g)!.join("-");
}

/** Spaces, dashes and case do not matter when it is typed. */
function normal(v: string): string {
  return v.toUpperCase().replace(/[\s-]/g, "");
}

/** Does `given` match the setup token? Constant-time. */
export function setupTokenMatches(given: unknown): boolean {
  if (typeof given !== "string" || !given.trim() || given.length > 200) return false;
  let expected: string;
  try {
    expected = normal(setupToken());
  } catch {
    return false; // no usable master key: setup cannot be authorised
  }
  const a = Buffer.from(normal(given));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

let lastPrinted = 0;

/** Print the token to the server log (at most once a minute). Never throws. */
export function printSetupToken(reason: "boot" | "page"): void {
  const now = Date.now();
  if (reason === "page" && now - lastPrinted < 60_000) return;
  lastPrinted = now;
  // 1.21.0: a cloud workspace's log goes to the platform's log store, which
  // never holds a secret (lib/log). The platform hands the token to the
  // customer (COMPASSDOCS_SETUP_TOKEN, or derived from the key it set).
  if (isCloud()) {
    logEvent("warn", "setup.waiting", {
      message: "CompassDocs is not set up yet. The first administrator opens /setup with the setup token CompassDocs Cloud gave them.",
    });
    return;
  }
  try {
    const token = setupToken();
    logEvent("warn", "setup.token", {
      token,
      message: `CompassDocs is not set up yet. To create the first administrator, open /setup and enter this setup token: ${token}`,
    });
  } catch (e) {
    logEvent("error", "setup.token_unavailable", { error: e instanceof Error ? e.message : String(e) });
  }
}
