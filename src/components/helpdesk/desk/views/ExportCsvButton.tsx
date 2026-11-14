"use client";

// The queue's Export CSV (1.20.8, lib/helpdesk/ticket-export): a quiet
// Download icon button in the list header, for people with tickets.export
// (as the time and report CSVs). It downloads every ticket the list holds
// (all pages of the view, team, saved view or filtered list, in its order)
// from GET /api/helpdesk/tickets/export with the list's own query. A list
// longer than the cap asks first and says how much will be left out; a
// refusal is a toast with the server's sentence.

import { useState } from "react";
import { Download } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { confirmDialog } from "@/components/Dialog";
import { toast } from "@/components/Toasts";
import { TICKET_EXPORT_MAX_ROWS } from "@/lib/helpdesk/ticket-export-shared";
import { useCan } from "../me";
import { saveDownload } from "../reports/data";

const CAP = TICKET_EXPORT_MAX_ROWS.toLocaleString("en");

export function ExportCsvButton({ listQs, total }: { listQs: string | null; total: number | null }) {
  const can = useCan();
  const [busy, setBusy] = useState(false);
  if (!can("tickets.export")) return null;

  async function run() {
    if (!listQs || busy) return;
    if (total !== null && total > TICKET_EXPORT_MAX_ROWS) {
      const ok = await confirmDialog({
        title: `Export the first ${CAP} tickets?`,
        body: `This list has ${total.toLocaleString("en")} tickets. The file holds the first ${CAP} in the list's order. Narrow the filters to export the rest.`,
        confirmLabel: `Export ${CAP}`,
      });
      if (ok !== true) return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/helpdesk/tickets/export?${listQs}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Couldn't export the tickets.");
      }
      const n = Number(res.headers.get("x-compass-export-rows") ?? "0");
      await saveDownload(res, "tickets.csv");
      toast("ok", n === 1 ? "Exported 1 ticket." : `Exported ${n.toLocaleString("en")} tickets.`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void run()}
      aria-disabled={!listQs || busy || undefined}
      aria-busy={busy || undefined}
      aria-label="Export these tickets as CSV"
      data-tt="Export CSV"
      className={iconButtonClass("quiet", "sm")}
    >
      <Download aria-hidden />
    </button>
  );
}
