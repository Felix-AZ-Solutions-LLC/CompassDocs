"use client";

import { SetByPlatform } from "./CloudManaged";
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button, buttonClass } from "@/components/Button";
import { RelativeTime } from "@/components/RelativeTime";
import { CLOUD_MANAGED_TITLE } from "@/lib/cloud";
import { confirmDialog } from "@/components/Dialog";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import { DangerZone, DangerAction, controlClass } from "@/components/form";
import { allowanceBreakdown } from "@/lib/agent-allowance";

interface FeatureRow {
  key: string;
  label: string;
  bundled: boolean;
  licensed: boolean;
  active: boolean;
}
interface LicenseView {
  edition: "enterprise" | "community";
  /** "platform" (1.21.0): cloud mode's COMPASSDOCS_LICENSE_KEY, read-only; "cloud" (1.21.3): fetched from the console. */
  source: "cloud" | "platform" | "settings" | "env" | "none";
  /** 1.21.3: cloud mode, the license is CompassDocs Cloud's (null otherwise). */
  cloud: {
    /** The console is asked for it (COMPASSDOCS_LICENSE_URL): Check now. */
    pull: boolean;
    /** The last check's outcome (any replica). */
    check: { checkedAt: string; result: CheckResult; message: string; updatedAt: string | null } | null;
  } | null;
  status: "none" | "invalid" | "active" | "grace" | "expired";
  reason?: string;
  daysLeft?: number;
  license: {
    customer: string;
    plan: string;
    seats: number;
    /** The key's helpdesk agent allowance; null = unlimited. */
    agents: number | null;
    issued: string;
    expires: string;
  } | null;
  seatsUsed: number;
  /** The agent allowance in force (null in grace or unlimited). */
  agentsAllowed: number | null;
  /** People on the desk; null when the helpdesk isn't on. */
  agentsUsed: number | null;
  buyAgentsUrl: string;
  features: FeatureRow[];
}

type CheckResult = "updated" | "unchanged" | "none" | "rejected" | "unreachable" | "unauthorized" | "error";
/** Outcomes that are fine: the license in force is the console's latest (or the console has none yet). */
const CHECK_OK: CheckResult[] = ["updated", "unchanged", "none"];

const field = controlClass(false);

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700",
  grace: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-700",
  invalid: "bg-red-100 text-red-700",
  none: "bg-slate-100 text-slate-600",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  grace: "In grace period",
  expired: "Expired",
  invalid: "Invalid",
  none: "No license",
};

export function LicensePanel() {
  const [v, setV] = useState<LicenseView | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/admin/license");
    if (res.ok) setV(await res.json());
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function send(payload: Record<string, unknown>, okText: string) {
    setSaving(true);
    const res = await fetch("/api/admin/license", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", data?.error || "Could not save.");
      return;
    }
    if (data?.state) setV(data.state);
    toast("ok", okText);
  }

  async function save() {
    if (!key.trim()) return;
    await send({ license_key: key.trim() }, "License installed.");
    setKey("");
  }
  async function remove() {
    if (
      !(await confirmDialog({
        title: "Remove the license?",
        body: "Enterprise features will turn off.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    await send({ clear: true }, "License removed.");
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mt-1 text-sm text-slate-500">
          Activate CompassDocs Enterprise features with your license key. The core app is free and
          open-source and never requires one.
        </p>
      </div>

      {loading && <LoadingRow />}

      {v && (
        <>
          {/* Edition + status banner */}
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                v.edition === "enterprise"
                  ? "bg-compass-100 text-compass-700"
                  : "bg-slate-100 text-slate-600"
              }`}
            >
              {v.edition === "enterprise" ? "Enterprise build" : "Community build"}
            </span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[v.status]}`}>
              {STATUS_LABEL[v.status]}
              {(v.status === "active" || v.status === "grace") && v.daysLeft != null
                ? ` · ${v.daysLeft}d left`
                : ""}
            </span>
            {v.source === "env" && (
              <span className="text-xs text-slate-500">from COMPASSDOCS_LICENSE_KEY</span>
            )}
          </div>

          {v.edition === "community" && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              This is the community build — it doesn&rsquo;t contain enterprise code, so a license
              won&rsquo;t unlock features here. Run the enterprise image to use them.
            </div>
          )}
          {v.status === "invalid" && v.reason && (
            <div className="notice-error rounded-lg border px-3 py-2 text-sm">
              {v.reason}
            </div>
          )}
          {v.status === "grace" && (
            <div className="notice-warn rounded-lg border px-3 py-2 text-sm">
              Your license has expired but is in a grace period. Renew to avoid losing enterprise
              features.
            </div>
          )}

          {/* License details */}
          {v.license && (
            <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
              <h3 className="mb-3 font-semibold text-slate-900">Details</h3>
              <dl className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
                <Row label="Customer" value={v.license.customer} />
                <Row label="Plan" value={v.license.plan} />
                <Row
                  label="Seats"
                  value={
                    v.license.seats === 0
                      ? `${v.seatsUsed} used · unlimited`
                      : `${v.seatsUsed} / ${v.license.seats}`
                  }
                />
                {v.agentsUsed !== null && (
                  <Row
                    label="Helpdesk agents"
                    value={
                      <AgentsValue
                        used={v.agentsUsed}
                        licensed={v.license.agents}
                        enforced={v.agentsAllowed !== null}
                        buyUrl={v.buyAgentsUrl}
                      />
                    }
                  />
                )}
                <Row label="Issued" value={v.license.issued} />
                <Row label="Expires" value={v.license.expires} />
              </dl>
            </div>
          )}

          {/* Entitlements */}
          <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <h3 className="mb-3 font-semibold text-slate-900">Enterprise features</h3>
            <ul className="space-y-2">
              {v.features.map((f) => (
                <li key={f.key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-700">{f.label}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      f.active
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                    data-tt={
                      f.active
                        ? "Enabled"
                        : !f.bundled
                          ? "Not in this build"
                          : !f.licensed
                            ? "Not in your license"
                            : "Off"
                    }
                  >
                    {f.active ? "Enabled" : !f.licensed ? "Not licensed" : "Not in build"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Key entry (1.21.0: the platform's key is shown, never replaced; 1.21.3: and the console's, with its last check) */}
          {v.cloud ? (
            <CloudLicense v={v} onState={setV} />
          ) : (
          <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900">
                {v.status === "none" ? "Add a license" : "Replace license"}
              </h3>
            </div>
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-label="License key"
              className={`${field} h-24 font-mono text-xs`}
              placeholder="Paste your license key…"
              spellCheck={false}
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={save}
                disabled={saving || !key.trim()}
                className={buttonClass("primary")}
              >
                {saving ? "Saving…" : "Activate"}
              </button>
            </div>
          </div>
          )}

          {v.source === "settings" && !v.cloud && (
            <DangerZone>
              <DangerAction
                label="Remove license"
                description="Enterprise features (the helpdesk, SSO, SCIM, audit export, training) turn off immediately. The workspace keeps running on the community edition."
              >
                <button
                  onClick={remove}
                  disabled={saving}
                  className={buttonClass("danger")}
                >
                  Remove license
                </button>
              </DangerAction>
            </DangerZone>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The license card in cloud mode (1.21.3, STYLEGUIDE §Settings pages, "A
 * setting the platform renews"): "Managed by CompassDocs Cloud", when the
 * license expires and, when the console is asked for it, when it last was,
 * what it said, and Check now.
 */
function CloudLicense({ v, onState }: { v: LicenseView; onState: (v: LicenseView) => void }) {
  const [checking, setChecking] = useState(false);
  const cloud = v.cloud!;
  const check = cloud.check;
  const ok = !check || CHECK_OK.includes(check.result);

  async function checkNow() {
    setChecking(true);
    const res = await fetch("/api/admin/license/check", { method: "POST" });
    setChecking(false);
    const data = await res.json().catch(() => ({}));
    if (data?.state) onState(data.state);
    if (!res.ok) {
      toast("error", data?.error || "Could not check for a renewed license.");
      return;
    }
    if (data.result === "updated") toast("ok", "Installed the renewed license.");
    else if (CHECK_OK.includes(data.result)) toast("ok", "The license is up to date.");
    else toast("error", "The license couldn't be checked. The license in force is kept.");
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-4 shadow-xs" data-testid="license-cloud">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-900">License key</h3>
        {cloud.pull && (
          <Button variant="secondary" size="sm" icon={<RefreshCw />} busy={checking} onClick={checkNow} className="print:hidden">
            Check now
          </Button>
        )}
      </div>
      <SetByPlatform label={CLOUD_MANAGED_TITLE}>
        CompassDocs Cloud keeps this workspace&rsquo;s license current{cloud.pull ? " and checks for a renewal about every 6 hours" : ""}.
      </SetByPlatform>
      <dl className="mt-3 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
        <Row
          label="Expires"
          value={
            v.license ? (
              <span data-testid="license-cloud-expires">
                {v.license.expires}
                {(v.status === "active" || v.status === "grace") && v.daysLeft != null && (
                  <span className="font-normal text-slate-500"> · {v.daysLeft}d left</span>
                )}
              </span>
            ) : (
              "Not installed yet"
            )
          }
        />
        {cloud.pull && (
          <Row
            label="Last checked"
            value={
              check ? (
                <span data-testid="license-cloud-checked">
                  <RelativeTime value={check.checkedAt} />
                </span>
              ) : (
                "Not yet"
              )
            }
          />
        )}
      </dl>
      {cloud.pull && check && (
        <p role="status" data-testid="license-cloud-check" className={`mt-2 text-xs ${ok ? "text-slate-500" : "ink-warn"}`}>
          {check.message}
        </p>
      )}
    </div>
  );
}

/**
 * "5 / 6 · 3 included, 3 bought  Buy more ↗"; past it the count is amber
 * with "· over by N". In grace (the key's number, nothing enforced) the over
 * count stays muted and says it isn't enforced.
 */
function AgentsValue({ used, licensed, enforced, buyUrl }: { used: number; licensed: number | null; enforced: boolean; buyUrl: string }) {
  if (licensed === null) return <>{used} used · unlimited</>;
  const over = used - licensed;
  const warn = over > 0 && enforced;
  const breakdown = allowanceBreakdown(licensed);
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1 text-right">
      <span>
        <span className={warn ? "ink-warn" : ""}>{used}</span> / {licensed}
      </span>
      {over > 0 && <span className={warn ? "ink-warn" : "font-normal text-slate-500"}>· over by {over}</span>}
      {over > 0 && !enforced && <span className="font-normal text-slate-500">· not enforced in grace</span>}
      {breakdown && <span className="font-normal text-slate-500">· {breakdown}</span>}
      <a className="link ml-1 inline-flex items-center gap-1 text-sm font-medium" href={buyUrl} target="_blank" rel="noopener noreferrer">
        Buy more<span className="sr-only"> helpdesk agents</span>
        <ExternalLink className="h-3 w-3" aria-hidden />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-1 last:border-0 sm:border-0">
      <dt className="shrink-0 whitespace-nowrap text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
