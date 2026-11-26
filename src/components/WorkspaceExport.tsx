"use client";

// Settings → Import & export → Workspace export (1.21.4, CompassDocs Cloud;
// lib/workspace-export; STYLEGUIDE §Settings pages, "Work that runs in the
// background after a button"). One card: the primary "Export the
// workspace" (asks first: the archive is the whole workspace, unencrypted),
// the export being made as one aria-live sentence over a progressbar (read
// again every 3 seconds while it runs), then each export kept: its state
// chip, size, SHA-256, when it stops being available, Download and Delete.

import { useCallback, useEffect, useState } from "react";
import { Download, PackageOpen, Trash2, TriangleAlert } from "lucide-react";
import { Card } from "@/components/Card";
import { Button, buttonClass } from "@/components/Button";
import { Chip, type ChipTone } from "@/components/Chip";
import { SectionEmpty } from "@/components/form";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { useFormatDate } from "@/components/SettingsProvider";
import type { ExportRow } from "@/lib/workspace-export";

const POLL_MS = 3_000;

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  running: { label: "Being made", tone: "accent" },
  ready: { label: "Ready", tone: "ok" },
  failed: { label: "Failed", tone: "error" },
  expired: { label: "Expired", tone: "neutral" },
  deleted: { label: "Deleted", tone: "neutral" },
};

/** Where a running export stands, as one sentence, and how far (0–100) when that is known. */
export function exportProgress(e: ExportRow): { sentence: string; percent: number | null } {
  if (e.stage === "database") return { sentence: `Exporting the database (${bytesLabel(e.bytes_done)} so far)…`, percent: null };
  if (e.stage === "files") {
    const pct = e.bytes_total ? Math.min(99, Math.floor((e.bytes_done / e.bytes_total) * 100)) : e.files_total ? Math.floor((e.files_done / e.files_total) * 100) : null;
    return { sentence: `Adding files: ${e.files_done} of ${e.files_total} (${bytesLabel(e.bytes_done)} of ${bytesLabel(e.bytes_total)})…`, percent: pct };
  }
  const pct = e.bytes_total ? Math.min(99, Math.floor((e.bytes_done / e.bytes_total) * 100)) : null;
  return { sentence: `Putting the archive together${pct === null ? "" : ` (${pct}%)`}…`, percent: pct };
}

export function WorkspaceExport({ initial, perDay, keepDays }: { initial: ExportRow[]; perDay: number; keepDays: number }) {
  const fmt = useFormatDate();
  const [rows, setRows] = useState<ExportRow[]>(initial);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const runningRow = rows.find((r) => r.status === "running") ?? null;

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/workspace-export", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { exports: ExportRow[] };
      setRows((before) => {
        const was = before.find((r) => r.status === "running");
        const now = was && data.exports.find((r) => r.id === was.id);
        if (was && now && now.status === "ready") toast("ok", "Your workspace export is ready to download.");
        if (was && now && now.status === "failed") toast("error", "The workspace export failed. The reason is under it.");
        return data.exports;
      });
    } catch {
      /* the next poll */
    }
  }, []);

  useEffect(() => {
    if (!runningRow) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [runningRow, reload]);

  async function start() {
    const yes = await confirmDialog({
      title: "Export the whole workspace?",
      body: "The archive holds the database and every file, unencrypted: whoever has it can read everything in the workspace. It is made in the background, can be downloaded for the next 7 days, and is in the audit log.",
      confirmLabel: "Start the export",
    });
    if (yes !== true) return;
    setStarting(true);
    try {
      const res = await fetch("/api/admin/workspace-export", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Couldn't start the export.");
      toast("ok", "The export has started. It keeps going if you leave this page.");
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Couldn't start the export.");
    } finally {
      setStarting(false);
    }
  }

  async function remove(row: ExportRow) {
    const yes = await confirmDialog({
      title: row.status === "running" ? "Stop and delete this export?" : "Delete this export?",
      body: "The archive is removed now and can't be downloaded again. You can start a new export.",
      confirmLabel: "Delete export",
      danger: true,
    });
    if (yes !== true) return;
    setDeleting(row.id);
    try {
      const res = await fetch(`/api/admin/workspace-export/${row.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Couldn't delete the export.");
      toast("ok", "Export deleted.");
      await reload();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Couldn't delete the export.");
    } finally {
      setDeleting(null);
    }
  }

  const shown = rows.filter((r) => r.status !== "deleted");
  const progress = runningRow ? exportProgress(runningRow) : null;
  return (
    <Card
      id="workspace-export"
      className="scroll-mt-6"
      icon={<PackageOpen />}
      title="Workspace export"
      description="A full copy of this workspace, the database and every file, as one archive you can keep or import into a self-hosted CompassDocs. Its README says how."
    >
      {runningRow && progress && (
        <div className="mb-4 space-y-2" data-testid="workspace-export-running">
          <p role="status" aria-live="polite" className="text-sm text-slate-700">
            {progress.sentence}
          </p>
          <div
            role="progressbar"
            aria-label="Workspace export progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent ?? undefined}
            aria-valuetext={progress.sentence}
            className="h-1.5 max-w-md overflow-hidden rounded-full bg-slate-100"
          >
            <div
              className={`h-full rounded-full bg-compass-600 transition-[width] ${progress.percent === null ? "w-1/3 animate-pulse motion-reduce:animate-none" : ""}`}
              style={progress.percent === null ? undefined : { width: `${Math.max(2, progress.percent)}%` }}
            />
          </div>
          <p className="text-xs text-slate-500">Started by {runningRow.requested_by_name || "an administrator"} <RelativeTime value={runningRow.created_at} />. It keeps going if you leave this page.</p>
        </div>
      )}

      {shown.length ? (
        <ul role="list" className="divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="workspace-exports">
          {shown.map((r) => {
            const st = STATUS[r.status] ?? { label: r.status, tone: "neutral" as ChipTone };
            return (
              <li key={r.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5" data-testid="workspace-export-row" data-status={r.status}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm text-slate-900">
                    <Chip tone={st.tone} size="sm">
                      {st.label}
                    </Chip>
                    <span className="font-medium wrap-anywhere">{r.file_name ?? "Workspace export"}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Started <RelativeTime value={r.created_at} /> by {r.requested_by_name || "an administrator"}
                    {r.size != null && <> · {bytesLabel(r.size)}</>}
                    {r.status === "ready" && r.expires_at && <> · available until {fmt.dateTime(r.expires_at)}</>}
                    {r.downloads > 0 && <> · downloaded {r.downloads === 1 ? "once" : `${r.downloads} times`}</>}
                  </p>
                  {r.status === "ready" && r.sha256 && (
                    <p className="mt-0.5 font-mono text-2xs text-slate-500 wrap-anywhere">
                      <span className="sr-only">SHA-256: </span>sha256 {r.sha256}
                    </p>
                  )}
                  {r.status === "failed" && r.error && (
                    <p className="mt-1 flex items-start gap-1.5 text-xs ink-warn">
                      <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                      {r.error}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 print:hidden">
                  {r.status === "ready" && (
                    <a href={`/api/admin/workspace-export/${r.id}`} download className={buttonClass("secondary", "sm")} data-testid="workspace-export-download">
                      <Download className="h-3.5 w-3.5" aria-hidden /> Download
                    </a>
                  )}
                  {(r.status === "ready" || r.status === "running") && (
                    <Button variant="danger" size="sm" icon={<Trash2 />} busy={deleting === r.id} onClick={() => remove(r)}>
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <SectionEmpty>No exports yet. An export appears here while it is being made, and can be downloaded once it is ready.</SectionEmpty>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 print:hidden">
        <Button icon={<PackageOpen />} busy={starting} disabled={!!runningRow} onClick={start}>
          Export the workspace
        </Button>
        <span className="text-xs text-slate-500">
          One at a time, up to {perDay} a day. Each archive can be downloaded for {keepDays} days, only from here, and every export and download is in the audit log.
        </span>
      </div>
    </Card>
  );
}
