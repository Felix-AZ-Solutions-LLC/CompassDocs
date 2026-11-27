"use client";

// Settings → Support access (1.21.4, lib/support; STYLEGUIDE §Settings
// pages, "Support access"). Stacked cards: unreviewed emergency access first
// (a notice each, with Mark reviewed), then Requests waiting (Approve /
// Deny), Active access (Revoke, at once and for every session of it), the
// two settings with one Save, and Past access with a link to the audit log,
// where every page viewed and every change is.

import { useState } from "react";
import { Check, History, Inbox, LifeBuoy, ScrollText, ShieldAlert, ShieldCheck, SlidersHorizontal, X, Ban, Eye } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Chip, type ChipTone } from "@/components/Chip";
import { Field, Select, SectionEmpty, Toggle } from "@/components/form";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import { useAction } from "@/lib/use-action";
import type { EmergencyAccess, SupportAccessItem, SupportAccessOverview } from "@/lib/support";

const LEVEL: Record<string, string> = { read_only: "Read-only", admin: "Administrator" };

function levelChip(level: string) {
  return (
    <Chip tone={level === "admin" ? "warn" : "info"} size="sm">
      {LEVEL[level] ?? level}
    </Chip>
  );
}

const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  pending: { label: "Waiting", tone: "accent" },
  approved: { label: "Active", tone: "ok" },
  denied: { label: "Denied", tone: "neutral" },
  revoked: { label: "Revoked", tone: "warn" },
  expired: { label: "Lapsed", tone: "neutral" },
  ended: { label: "Ended", tone: "neutral" },
};

export function durationLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  if (minutes < 60) return `${minutes} minutes`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function Who({ item }: { item: SupportAccessItem }) {
  return (
    <p className="text-sm text-slate-900">
      <span className="font-semibold">{item.staff_name}</span> <span className="text-slate-500 wrap-anywhere">{item.staff_email}</span>
    </p>
  );
}

function Totals({ item }: { item: SupportAccessItem }) {
  const pages = item.sessions.reduce((n, s) => n + s.pages, 0);
  const changes = item.sessions.reduce((n, s) => n + s.actions, 0);
  const n = item.sessions.length;
  if (!n) return <>not signed in</>;
  return (
    <>
      {n} sign-in{n === 1 ? "" : "s"} · {pages} page{pages === 1 ? "" : "s"} viewed · {changes} change{changes === 1 ? "" : "s"}
    </>
  );
}

const ROW = "flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3";

export function SupportAccessPanel({ overview }: { overview: SupportAccessOverview }) {
  const fmt = useFormatDate();
  const { run, isBusy } = useAction();
  const [requests, setRequests] = useState(overview.settings.requests);
  const [emergency, setEmergency] = useState<EmergencyAccess>(overview.settings.emergency);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(overview.settings);
  const dirty = requests !== saved.requests || emergency !== saved.emergency;

  const decide = (item: SupportAccessItem, action: "approve" | "deny" | "revoke" | "review", ok: string) =>
    run(
      `${item.id}:${action}`,
      () =>
        fetch(`/api/admin/support/requests/${encodeURIComponent(item.id)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      { fallback: "Couldn't save that. Try again.", ok }
    );

  async function approve(item: SupportAccessItem) {
    const yes = await confirmDialog({
      title: `Let ${item.staff_name} in?`,
      body: `${LEVEL[item.level]} access for ${durationLabel(item.duration_minutes)}, starting now. Every page opened and every change made is in the audit log, and you can revoke it at any time.`,
      confirmLabel: "Approve",
    });
    if (yes === true) await decide(item, "approve", `Approved: ${item.staff_name} can sign in for ${durationLabel(item.duration_minutes)}.`);
  }

  async function revoke(item: SupportAccessItem) {
    const yes = await confirmDialog({
      title: `Revoke ${item.staff_name}'s access?`,
      body: "Any session open now ends at once, and the access can't be used again. CompassDocs support would have to ask again.",
      confirmLabel: "Revoke access",
      danger: true,
    });
    if (yes === true) await decide(item, "revoke", "Access revoked.");
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/support", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests, emergency }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; settings?: { requests: boolean; emergency: EmergencyAccess } };
      if (!res.ok || !data.settings) throw new Error(data.error || "Couldn't save the support access settings.");
      setSaved(data.settings);
      toast("ok", "Support access settings saved.");
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Couldn't save the support access settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {overview.unreviewed.map((item) => (
        <div key={item.id} role="note" className="notice-warn rounded-xl border p-4 text-sm" data-testid="support-emergency">
          <p className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
            Emergency access by {item.staff_name}, {fmt.dateTime(item.window_starts ?? item.requested_at)}
          </p>
          <p className="mt-1">
            CompassDocs support signed in without waiting for approval, as your emergency access setting allows. Their reason: “{item.emergency_reason}”
          </p>
          <p className="mt-1 text-xs">
            {LEVEL[item.level]} · <Totals item={item} /> · {item.status === "approved" ? "still open" : "ended"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 print:hidden">
            <Button variant="secondary" size="sm" icon={<Check />} busy={isBusy(`${item.id}:review`)} onClick={() => decide(item, "review", "Marked reviewed.")}>
              Mark reviewed
            </Button>
            <Button variant="ghost" size="sm" icon={<ScrollText />} href="/admin/audit?category=support">
              See what they did
            </Button>
          </div>
        </div>
      ))}

      <Card
        id="waiting"
        className="scroll-mt-6"
        icon={<Inbox />}
        title="Requests waiting"
        description="CompassDocs support can open this workspace only when an administrator approves a request here. Approved access lasts as long as the request says, and you can end it at any moment."
        padding="none"
      >
        {overview.pending.length ? (
          <ul role="list" className="divide-y divide-slate-100" data-testid="support-pending">
            {overview.pending.map((item) => (
              <li key={item.id} className={ROW} data-testid="support-request">
                <div className="min-w-0 flex-1 basis-72">
                  <Who item={item} />
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    {levelChip(item.level)} for {durationLabel(item.duration_minutes)} · asked <RelativeTime value={item.requested_at} /> · lapses{" "}
                    <RelativeTime value={item.expires_at} />
                  </p>
                  <p className="mt-1.5 text-sm text-slate-700 wrap-anywhere">{item.reason}</p>
                </div>
                <div className="flex flex-wrap gap-2 print:hidden">
                  <Button size="sm" icon={<Check />} busy={isBusy(`${item.id}:approve`)} onClick={() => approve(item)}>
                    Approve
                  </Button>
                  <Button variant="secondary" size="sm" icon={<X />} busy={isBusy(`${item.id}:deny`)} onClick={() => decide(item, "deny", "Request denied.")}>
                    Deny
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SectionEmpty className="px-4 py-6">No requests are waiting. When CompassDocs support asks for access, it shows here and in administrators’ notifications.</SectionEmpty>
        )}
      </Card>

      <Card id="active" className="scroll-mt-6" icon={<ShieldCheck />} title="Active access" padding="none">
        {overview.active.length ? (
          <ul role="list" className="divide-y divide-slate-100" data-testid="support-active">
            {overview.active.map((item) => (
              <li key={item.id} className={ROW} data-testid="support-active-item">
                <div className="min-w-0 flex-1 basis-72">
                  <Who item={item} />
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    {levelChip(item.level)}
                    {item.kind === "emergency" && (
                      <Chip tone="error" size="sm">
                        Emergency
                      </Chip>
                    )}
                    until {fmt.dateTime(item.window_ends)} · <Totals item={item} />
                  </p>
                  <p className="mt-1.5 text-sm text-slate-700 wrap-anywhere">{item.reason}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {item.kind === "emergency" ? "Emergency access (your setting allows it)" : `Approved by ${item.decided_by_name ?? "an administrator"}`}
                    {item.decided_at && (
                      <>
                        {" "}
                        <RelativeTime value={item.decided_at} />
                      </>
                    )}
                  </p>
                </div>
                <div className="print:hidden">
                  <Button variant="danger" size="sm" icon={<Ban />} busy={isBusy(`${item.id}:revoke`)} onClick={() => revoke(item)}>
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SectionEmpty className="px-4 py-6">Nobody from CompassDocs support has access now.</SectionEmpty>
        )}
      </Card>

      <Card id="settings" className="scroll-mt-6" icon={<SlidersHorizontal />} title="Settings">
        <div className="space-y-5">
          <Toggle
            label="Let CompassDocs support ask for access"
            help="Each request still waits for an administrator to approve it. Turned off, support can't ask."
            checked={requests}
            onChange={setRequests}
          />
          <Field
            label="Emergency access without approval"
            size="md"
            help="For an outage that can't wait. Anyone who can approve requests is told at once, and every settings page says so until one of you marks it reviewed."
          >
            <Select value={emergency} onChange={(e) => setEmergency(e.target.value as EmergencyAccess)}>
              <option value="off">Not allowed</option>
              <option value="read_only">Allowed, read-only</option>
              <option value="admin">Allowed, read-only or administrator</option>
            </Select>
          </Field>
          <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-500 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="font-medium text-slate-700">
              <Eye className="mr-1 inline h-3.5 w-3.5 align-[-0.125rem]" aria-hidden />
              Read-only
            </dt>
            <dd>Sees what an administrator sees, and can change nothing.</dd>
            <dt className="font-medium text-slate-700">
              <LifeBuoy className="mr-1 inline h-3.5 w-3.5 align-[-0.125rem]" aria-hidden />
              Administrator
            </dt>
            <dd>Can change what an administrator can, except sign-in and single sign-on, passwords, people and roles, the license, API tokens, backups and exports.</dd>
          </dl>
        </div>
        <div className="mt-4 flex items-center gap-3 print:hidden">
          <Button busy={saving} disabled={!dirty} onClick={save}>
            Save
          </Button>
          {dirty ? <span className="text-xs ink-warn">Unsaved changes</span> : <span className="text-xs text-slate-500">Saved</span>}
        </div>
      </Card>

      <Card
        id="history"
        className="scroll-mt-6"
        icon={<History />}
        title="Past access"
        description="The last 50 requests and emergency sign-ins. The audit log has every page viewed and every change made."
        padding="none"
        actions={
          <Button variant="secondary" size="sm" icon={<ScrollText />} href="/admin/audit?category=support" className="print:hidden">
            Open the audit log
          </Button>
        }
      >
        {overview.history.length ? (
          <ul role="list" className="divide-y divide-slate-100" data-testid="support-history">
            {overview.history.map((item) => {
              const st = STATUS[item.status] ?? { label: item.status, tone: "neutral" as ChipTone };
              return (
                <li key={item.id} className={ROW} data-testid="support-history-item">
                  <div className="min-w-0 flex-1 basis-72">
                    <Who item={item} />
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      <Chip tone={st.tone} size="sm">
                        {st.label}
                      </Chip>
                      {levelChip(item.level)}
                      {item.kind === "emergency" && (
                        <Chip tone="error" size="sm">
                          Emergency
                        </Chip>
                      )}
                      asked <RelativeTime value={item.requested_at} /> · <Totals item={item} />
                    </p>
                    <p className="mt-1.5 text-sm text-slate-700 wrap-anywhere">{item.reason}</p>
                    {item.decided_by_name && item.kind === "request" && (
                      <p className="mt-1 text-xs text-slate-500">
                        {item.status === "denied" ? "Denied" : "Approved"} by {item.decided_by_name}
                        {item.status === "revoked" && item.sessions[0]?.ended_by_name ? ` · revoked by ${item.sessions[0].ended_by_name}` : ""}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <SectionEmpty className="px-4 py-6">No support access yet. Each request and sign-in will be listed here.</SectionEmpty>
        )}
      </Card>
      <p className="hidden text-xs text-slate-500 print:block">Workspace {overview.workspaceId}</p>
    </div>
  );
}
