"use client";

// The plan's admin banner (1.22.0, design B and F; STYLEGUIDE §Plan
// notices). Under the greeting on the dashboard and under the "Settings"
// eyebrow on every settings page, only for whoever can open Plan & usage
// (the slot mounts it; non-admins and self-hosted workspaces never fetch).
//
//   - One banner for the thresholds reached this month, however many
//     meters: 80% is notice-info (a fact), the limit and past the buffer
//     notice-warn, never notice-error (nothing has gone wrong). Every
//     sentence says that nothing stops. Only the past-the-buffer one carries
//     the upgrade; the others link to the page. Dismiss hides those
//     thresholds for this admin until the next threshold or the next month.
//     Not repeated on Plan & usage itself, whose meters already say it.
//   - The licence-mismatch notice (design F): notice-error, plain words,
//     never dismissible; one line on the dashboard.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Info, ShieldAlert, Sparkles, TriangleAlert, X } from "lucide-react";
import { buttonClass, iconButtonClass } from "@/components/Button";
import { CopyButton } from "@/components/CopyButton";
import { toast } from "@/components/Toasts";
import { PLAN_CATALOGUE, planLabel, shortDate, SUPPORT_EMAIL, type LicenceMismatch, type PlanName, type PlanNotice } from "@/lib/plan-shared";
import { PLAN_CHANGED_EVENT } from "./plan-data";

interface NoticesBody {
  notices: PlanNotice[];
  mismatch: LicenceMismatch | null;
  plan: PlanName | null;
}

export function PlanBanner({ place }: { place: "dashboard" | "settings" }) {
  const [data, setData] = useState<NoticesBody | null>(null);
  const [hidden, setHidden] = useState(false);
  const path = usePathname() ?? "";
  // Read again on every page (the settings layout stays mounted between them) and after a Plan & usage change.
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    const on = () => setChanged((n) => n + 1);
    window.addEventListener(PLAN_CHANGED_EVENT, on);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, on);
  }, []);
  useEffect(() => {
    let live = true;
    fetch("/api/plan/notices", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as NoticesBody) : null))
      .then((b) => {
        if (!live) return;
        setData(b);
        setHidden(false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path, changed]);
  if (!data) return null;
  const onPlanPage = path.startsWith("/admin/plan");
  const notices = onPlanPage || hidden ? [] : data.notices;
  if (!notices.length && !data.mismatch) return null;

  async function dismiss() {
    setHidden(true);
    const res = await fetch("/api/plan/notices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismiss: notices.map((n) => ({ meter: n.meter, threshold: n.threshold })) }),
    }).catch(() => null);
    if (!res?.ok) {
      setHidden(false);
      toast("error", "Couldn't dismiss the banner.");
    }
  }

  const warn = notices.some((n) => n.tone === "warn");
  const past = notices.find((n) => n.threshold === "past");
  const next = data.plan ? PLAN_CATALOGUE[data.plan].next : null;
  const onlyAi = notices.length > 0 && notices.every((n) => n.meter === "ai");
  const Icon = onlyAi ? Sparkles : warn ? TriangleAlert : Info;

  return (
    <div className="mb-4 flex flex-col gap-3 print:hidden" data-testid="plan-banner">
      {data.mismatch && <MismatchNotice m={data.mismatch} short={place === "dashboard"} />}
      {notices.length > 0 && (
        <div role="note" aria-label="Plan usage" className={`${warn ? "notice-warn" : "notice-info"} flex items-start gap-2 rounded-lg border px-3 py-2 text-sm`} data-plan-tone={warn ? "warn" : "info"}>
          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? "" : "text-compass-600"}`} aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            {notices.map((n) => (
              <p key={`${n.meter}:${n.threshold}`} data-plan-notice={`${n.meter}:${n.threshold}`}>
                {/* Design B2: the dashboard says it in one short line; the settings pages in full. */}
                <b className="font-semibold">{place === "dashboard" ? n.short.lead : n.lead}</b> {place === "dashboard" ? n.short.rest : n.rest}{" "}
                {!past && n === notices[notices.length - 1] && (
                  <Link href={onlyAi && n.threshold === "limit" ? "/admin/plan/ai#ai-spending" : "/admin/plan"} className="link font-medium">
                    {onlyAi && n.threshold === "limit" ? "Set a spending cap" : "Open Plan & usage"}
                  </Link>
                )}
              </p>
            ))}
            {past && (
              <div className="flex flex-wrap gap-2 pt-1">
                {next && (
                  <Link href="/admin/plan#upgrade" className={buttonClass("primary", "sm")}>
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                    {next === "dedicated" ? "Talk to us about Dedicated" : `Upgrade to ${planLabel(next)}`}
                  </Link>
                )}
                <Link href="/admin/plan" className={buttonClass("secondary", "sm")}>
                  Open Plan & usage
                </Link>
              </div>
            )}
          </div>
          <button type="button" onClick={dismiss} className={iconButtonClass("quiet", "sm", "-my-1 -mr-1 shrink-0")} aria-label="Dismiss until the next threshold or next month" data-tt="Dismiss">
            <X aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

/** Design F: the licence in force names another workspace. Our setup problem, said plainly; the workspace keeps running on the last licence that matched. */
function MismatchNotice({ m, short }: { m: LicenceMismatch; short: boolean }) {
  // Said once, and only what is true: with an earlier matching licence the plan runs on it; without one there is no plan yet.
  const running = m.runningOn
    ? `It runs on its last license that matched (${planLabel(m.runningOn.plan)}, renews ${shortDate(m.runningOn.renewsAt)}). Plan & usage shows the counts, and nothing is billed until this is fixed.`
    : "There is no earlier license for this workspace to run on, so Plan & usage has no plan to show yet, and nothing is billed until this is fixed.";
  if (short) {
    return (
      <div role="note" className="notice-error flex items-start gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="plan-mismatch">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          <b className="font-semibold">This workspace's plan license is for a different workspace.</b> Everything keeps working.{" "}
          <Link href="/admin/license" className="link font-medium">
            See what to do
          </Link>
        </p>
      </div>
    );
  }
  const details = `License names ${m.licenseWorkspace}; this workspace is ${m.workspaceId}.`;
  return (
    <div role="note" className="notice-error space-y-1.5 rounded-lg border px-3 py-2 text-sm" data-testid="plan-mismatch">
      <p className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          <b className="font-semibold">This workspace's plan license is for a different workspace.</b> It names{" "}
          <code className="font-mono text-xs">{m.licenseWorkspace}</code>, and this workspace is <code className="font-mono text-xs">{m.workspaceId}</code>. This is a setup
          problem on our side, not something you did.
        </span>
      </p>
      <p className="pl-6">
        <b className="font-semibold">Everything keeps working, and nothing is lost.</b> {running}
      </p>
      <p className="pl-6">
        We've been told automatically. If it isn't fixed within a day, contact CompassDocs support:{" "}
        <a className="link" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`License for the wrong workspace (${m.workspaceId})`)}`}>
          {SUPPORT_EMAIL}
        </a>
        , and quote <code className="font-mono text-xs">{m.workspaceId}</code>.
      </p>
      <div className="flex flex-wrap gap-2 pl-6 pt-0.5">
        <Link href="/admin/license" className={buttonClass("secondary", "sm")}>
          Open License
        </Link>
        <CopyButton text={details} label="Copy details" />
      </div>
    </div>
  );
}
