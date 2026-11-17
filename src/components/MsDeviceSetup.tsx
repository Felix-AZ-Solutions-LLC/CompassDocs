"use client";

// Shared "one-click Microsoft setup" wizard (used by the SSO and directory
// sync panels, and by the helpdesk's Microsoft Intune page since 1.20.4).
// Starts the enterprise device-code flow, shows the code to
// enter at microsoft.com/devicelogin, polls until the tenant admin finishes
// signing in, then refetches the panel's state and hands it to the caller.
//
// 1.20.4: the poll that follows the sign-in does the setup's work and may
// take a while (Intune waits for Microsoft to activate the new app), so
// once a poll has been out for a few seconds the line says "Setting it up
// with Microsoft. This can take a minute…" and cancel is gone: the server
// finishes whatever the page does. The poll's answer goes to onDone and, when
// doneMessage is a function, picks the closing words (doneWarn: as a
// warning notice, for a setup that finished with something left to do).
//
// 1.20.27 (SCIM provisioning, a setup of several steps): `label` names the
// button, `beforeStart` may ask first (a confirmDialog) and `startBody` is
// sent with the start, so what the admin chose is what the server does.
// `details` renders the poll's answer under the closing notice, and under
// the error when the setup stopped part-way (its steps, in words);
// `onError` hears that answer too (the panel refetches its state: a setup
// can change things before it stops).

import { useRef, useState, type ReactNode } from "react";
import { buttonClass } from "@/components/Button";

export function MsDeviceSetup({
  startUrl,
  pollUrl,
  refreshUrl,
  blurb,
  doneMessage,
  doneWarn,
  onDone,
  label = "Set up automatically with Microsoft",
  beforeStart,
  startBody,
  details,
  onError,
  children,
}: {
  startUrl: string;
  pollUrl: string;
  /** Admin view endpoint refetched after success; its JSON goes to onDone. */
  refreshUrl: string;
  blurb: ReactNode;
  doneMessage: string | ((result: any) => string);
  /** True when the setup finished with something left for the admin to do: the closing notice is a warning. */
  doneWarn?: (result: any) => boolean;
  /** `result` is the poll's own answer ({ status: "done", … }). */
  onDone: (state: any, result: any) => void;
  /** The button's words. */
  label?: string;
  /** Resolve false to stay put (the admin said no). */
  beforeStart?: () => Promise<boolean>;
  /** JSON sent with the start request. */
  startBody?: () => unknown;
  /** The poll's answer, done or failed, in detail (failed: the setup stopped). */
  details?: (result: any, failed: boolean) => ReactNode;
  /** The setup stopped: the poll's error answer. */
  onError?: (body: any) => void;
  /** Options shown under the button while idle. */
  children?: ReactNode;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "done">("idle");
  const [code, setCode] = useState("");
  const [uri, setUri] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [failure, setFailure] = useState<any>(null);
  const stop = useRef(false);

  async function begin() {
    if (beforeStart && !(await beforeStart())) return;
    setError("");
    setFailure(null);
    setPhase("starting");
    stop.current = false;
    const body = startBody?.();
    const res = await fetch(
      startUrl,
      body === undefined ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A 404 is an enterprise build from before this setup existed (the route is its own).
      setError(data?.error || (res.status === 404 ? "This build can't do this setup yet. Update the enterprise image, or enter the details by hand." : "Could not start Microsoft sign-in."));
      setPhase("idle");
      return;
    }
    setCode(data.user_code);
    setUri(data.verification_uri);
    setPhase("waiting");

    const intervalMs = Math.max(2, data.interval ?? 5) * 1000;
    const deadline = Date.now() + (data.expires_in ?? 900) * 1000;
    while (!stop.current && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stop.current) return;
      // "Not yet" answers at once: a poll still out after a few seconds is the setup itself running.
      const slow = setTimeout(() => setWorking(true), 3000);
      let p: Response;
      try {
        p = await fetch(pollUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setup_id: data.setup_id }),
        });
      } finally {
        clearTimeout(slow);
        setWorking(false);
      }
      const pd = await p.json().catch(() => ({}));
      if (p.ok && pd.status === "done") {
        setResult(pd);
        setPhase("done");
        const fresh = await fetch(refreshUrl);
        if (fresh.ok) onDone(await fresh.json(), pd);
        return;
      }
      if (!p.ok) {
        setError(pd?.error || "Setup failed.");
        setFailure(pd);
        setPhase("idle");
        onError?.(pd);
        return;
      }
    }
    if (!stop.current) {
      setError("The sign-in window expired — try again.");
      setPhase("idle");
    }
  }

  if (phase === "done") {
    return (
      <div className="mb-4">
        <div className={`${doneWarn?.(result) ? "notice-warn" : "notice-ok"} rounded-lg border px-3 py-2 text-sm`} role="status">
          {typeof doneMessage === "function" ? doneMessage(result) : doneMessage}
        </div>
        {details?.(result, false)}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-compass-100 bg-compass-50/50 p-3">
      {phase === "waiting" ? (
        <div className="text-sm text-slate-700">
          <p>
            Go to{" "}
            <a
              href={uri}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-compass-600 underline"
            >
              {uri.replace(/^https?:\/\//, "")}
            </a>{" "}
            and enter the code{" "}
            <code className="rounded-sm bg-surface px-2 py-0.5 font-mono text-base font-bold tracking-widest ring-1 ring-slate-200">
              {code}
            </code>
            , signing in as a tenant admin.
          </p>
          <p className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-compass-500" />
            {working ? (
              "Setting it up with Microsoft. This can take a minute…"
            ) : (
              <>
                Waiting for you to finish signing in…
                <button
                  className="font-medium text-slate-400 underline hover:text-slate-600"
                  onClick={() => {
                    stop.current = true;
                    setPhase("idle");
                  }}
                >
                  cancel
                </button>
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={begin}
            disabled={phase === "starting"}
            className={buttonClass("primary")}
          >
            {phase === "starting" ? "Contacting Microsoft…" : label}
          </button>
          <span className="text-xs text-slate-500">{blurb}</span>
        </div>
      )}
      {phase !== "waiting" && children}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {error && failure && details?.(failure, true)}
    </div>
  );
}
