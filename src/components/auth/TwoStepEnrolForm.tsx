"use client";

// The forced two-step set-up (1.20.27, security review H3; /account/two-step).
// Three steps in the sign-in column: one button that prepares a secret, the
// QR code with the 6-digit code field, then the recovery codes shown once
// with "Continue". The same /api/account/2fa routes as Account → Security,
// which answer this session while it owes exactly this step.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClass } from "@/components/Button";
import { Field, FormError, TextInput } from "@/components/form";
import { Spinner } from "@/components/Spinner";
import { SignOutLink } from "@/components/SignOutLink";
import { CopyButton } from "@/components/CopyButton";
import { IdentifierRow } from "@/components/auth/IdentifierRow";

type Phase = { step: "start" } | { step: "scan"; qr: string; secret: string } | { step: "codes"; codes: string[] };

export function TwoStepEnrolForm({ account, next }: { account: string; next: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ step: "start" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tried, setTried] = useState(false);

  async function post(body: unknown): Promise<any | null> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/account/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ? String(data.error) : "Something went wrong. Try again.");
        return null;
      }
      return data;
    } catch {
      setError("CompassDocs can't be reached. Check your connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    const data = await post({ action: "setup" });
    if (data) setPhase({ step: "scan", qr: data.qr, secret: data.secret });
  }

  const digits = code.replace(/\D/g, "");
  const codeError = digits.length !== 6 ? "Enter the 6-digit code your app shows." : undefined;

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (codeError || busy) return;
    const data = await post({ action: "enable", code: digits });
    if (data) setPhase({ step: "codes", codes: data.recovery_codes || [] });
  }

  const signOut = <SignOutLink className={buttonClass("ghost", "sm")} />;

  if (phase.step === "start") {
    return (
      <div className="space-y-4">
        <IdentifierRow label="Signed in as" value={account} action={signOut} />
        <p className="text-sm text-slate-600">
          You need an authenticator app on your phone, such as Microsoft Authenticator, Google Authenticator or 1Password.
        </p>
        <FormError>{error}</FormError>
        <button type="button" onClick={() => void begin()} aria-disabled={busy || undefined} className={buttonClass("primary", "lg", "w-full")}>
          {busy && <Spinner />}
          Set up two-step sign-in
        </button>
      </div>
    );
  }

  if (phase.step === "scan") {
    return (
      <form method="post" noValidate aria-labelledby="auth-title" aria-busy={busy || undefined} onSubmit={confirm} className="space-y-4">
        <IdentifierRow label="Signed in as" value={account} action={signOut} />
        <div className="flex flex-col items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={phase.qr} alt="QR code to scan with your authenticator app" width={176} height={176} className="rounded-lg ring-1 ring-slate-200" />
          <p className="text-sm text-slate-600">Scan this with your authenticator app, then enter the code it shows.</p>
          <p className="text-xs text-slate-500">
            Can&rsquo;t scan? Enter this key in the app instead: <code className="break-all font-mono">{phase.secret}</code>
          </p>
        </div>
        <Field label="6-digit code" error={tried ? codeError : undefined}>
          <TextInput
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={10}
            className="h-10 text-base tracking-widest sm:text-sm"
          />
        </Field>
        <FormError>{error}</FormError>
        <button type="submit" aria-disabled={busy || undefined} className={buttonClass("primary", "lg", "w-full")}>
          {busy && <Spinner />}
          Turn on and continue
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="notice-warn rounded-lg border p-3 text-sm">
        <p className="font-semibold">Save these recovery codes now. They are shown only once.</p>
        <p className="mt-1 text-xs">Each one signs you in once if you lose your phone.</p>
        <pre className="mt-2 grid grid-cols-2 gap-x-6 rounded-sm bg-surface p-3 font-mono text-[0.8125rem] leading-6 ring-1 ring-amber-200">
          {phase.codes.join("\n")}
        </pre>
        <CopyButton text={phase.codes.join("\n")} label="Copy codes" size="sm" className="mt-2" />
      </div>
      <button
        type="button"
        onClick={() => {
          router.push(next);
          router.refresh();
        }}
        className={buttonClass("primary", "lg", "w-full")}
      >
        I&rsquo;ve saved them, continue
      </button>
    </div>
  );
}
