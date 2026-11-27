"use client";

// The support sign-in step (1.21.4, lib/support; STYLEGUIDE §Sign-in
// surfaces, "The support sign-in"). Reads the grant token from the address's
// fragment and takes it out of the address bar at once, shows who it is for
// as the token itself says (unverified: the server checks everything), and
// posts it when the person presses the one button. Nothing happens by
// itself: a support session always starts with a click.

import { useEffect, useState } from "react";
import { LifeBuoy } from "lucide-react";
import { buttonClass } from "@/components/Button";
import { FormError } from "@/components/form";
import { Spinner } from "@/components/Spinner";

interface Preview {
  name: string;
  level: string;
  reason: string;
  emergency: boolean;
}

/** What the token says about itself, for the page to show (never trusted). */
function preview(token: string): Preview | null {
  try {
    const part = token.split(".")[0] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const o = JSON.parse(decodeURIComponent(escape(json))) as Record<string, unknown>;
    const staff = (o.staff ?? {}) as Record<string, unknown>;
    return {
      name: String(staff.name ?? "").slice(0, 120),
      level: o.level === "admin" ? "Administrator" : "Read-only",
      reason: String(o.reason ?? "").slice(0, 500),
      emergency: typeof o.emergency === "string",
    };
  } catch {
    return null;
  }
}

export function SupportSignIn() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = decodeURIComponent(window.location.hash.replace(/^#/, "")).trim();
    // Out of the address bar and the history entry at once: the token is for one use, by this page.
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    setToken(t || null);
    setReady(true);
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/support/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; next?: string };
      if (!res.ok) throw new Error(data.error || "The support sign-in was refused.");
      setToken(null);
      window.location.assign(data.next || "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The support sign-in was refused.");
      setBusy(false);
    }
  }

  if (!ready) return null;
  if (!token) {
    return (
      <p className="text-sm text-slate-600" data-testid="support-sign-in-missing">
        Open this page from the CompassDocs console: its sign-in link carries your one-time access. A link can be used once; ask the console for a new
        one if this one was already used.
      </p>
    );
  }
  const p = preview(token);
  return (
    <form onSubmit={signIn} aria-labelledby="auth-title" className="space-y-5">
      {p && (
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-slate-200 bg-canvas px-3 py-2.5 text-sm" data-testid="support-sign-in-preview">
          <dt className="text-slate-500">Staff</dt>
          <dd className="font-medium text-slate-900 wrap-anywhere">{p.name}</dd>
          <dt className="text-slate-500">Access</dt>
          <dd className="text-slate-900">
            {p.level}
            {p.emergency ? " (emergency)" : ""}
          </dd>
          <dt className="text-slate-500">Reason</dt>
          <dd className="text-slate-900 wrap-anywhere">{p.reason}</dd>
        </dl>
      )}
      <FormError>{error}</FormError>
      <button type="submit" className={buttonClass("primary", "lg", "w-full")} aria-disabled={busy || undefined}>
        {busy ? <Spinner size="md" /> : <LifeBuoy className="h-4 w-4" aria-hidden />}
        Sign in as CompassDocs support
      </button>
      <p className="text-xs text-slate-500">
        Any account signed in on this browser is signed out first. The session ends by itself when the access does, and an administrator of this
        workspace can end it at any time.
      </p>
    </form>
  );
}
