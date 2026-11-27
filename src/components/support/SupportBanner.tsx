"use client";

// The support banner (1.21.4, STYLEGUIDE §Notices, "A support session"):
// on every page of a CompassDocs support session (lib/support), so the staff
// member always sees whose workspace this is, at which level and until
// when, with End session one click away. A `notice-warn` strip: in the app
// shell it is sticky at the top of the content column; in the desk
// (`floating`) a bar fixed at the bottom so the desk's own top bar stays
// usable. Never shown to the customer's own accounts (SessionUser.support
// is set only for a support session).

import { useEffect, useState } from "react";
import { LifeBuoy, LogOut } from "lucide-react";
import { Button } from "@/components/Button";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import type { SupportSessionFacts } from "@/lib/types";

/** "2 h 05 min" / "12 min" / "less than a minute" until `iso`. */
export function timeLeft(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms < 60_000) return "less than a minute";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function SupportBanner({ support, floating = false }: { support: SupportSessionFacts; floating?: boolean }) {
  const fmt = useFormatDate();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const ends = new Date(support.expires_at).getTime();

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // At its end the session is over: the next request would find no session, so go to the sign-in page now.
  useEffect(() => {
    const ms = ends - Date.now();
    const t = setTimeout(() => window.location.assign("/login"), Math.max(0, Math.min(ms + 1_000, 2_147_000_000)));
    return () => clearTimeout(t);
  }, [ends]);

  async function end() {
    setBusy(true);
    try {
      const res = await fetch("/api/support/session", { method: "DELETE" });
      if (!res.ok) throw new Error();
      window.location.assign("/login");
    } catch {
      setBusy(false);
      toast("error", "Couldn't end the support session. Try again.");
    }
  }

  const level = support.level === "admin" ? "Administrator" : "Read-only";
  return (
    <div
      role="region"
      aria-label="CompassDocs support session"
      data-testid="support-banner"
      className={
        floating
          ? "notice-warn fixed inset-x-2 bottom-2 z-50 rounded-lg border px-3 py-2 text-sm shadow-float sm:inset-x-auto sm:left-1/2 sm:max-w-3xl sm:-translate-x-1/2"
          : "notice-warn sticky top-0 z-30 border-b px-4 py-2 text-sm sm:px-8"
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <LifeBuoy className="h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 basis-64">
          <span className="font-semibold">CompassDocs support session</span>
          {support.emergency && <span className="font-semibold"> (emergency access)</span>}
          {" · "}
          <span data-testid="support-banner-level">{level}</span>
          {support.level === "read_only" && <span>: nothing here can be changed</span>}
          {" · "}
          {support.staff_name}
          {" · ends "}
          <time dateTime={support.expires_at} data-tt={fmt.dateTime(support.expires_at)} tabIndex={0}>
            in {timeLeft(support.expires_at, now)}
          </time>
        </p>
        <Button variant="secondary" size="sm" icon={<LogOut />} busy={busy} onClick={end} className="print:hidden">
          End session
        </Button>
      </div>
    </div>
  );
}
