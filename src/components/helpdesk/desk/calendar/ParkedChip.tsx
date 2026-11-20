"use client";

// The ticket header's Parked chip (1.20.34, lib/helpdesk/desk-calendar-park;
// STYLEGUIDE §Helpdesk: the event calendar). A status, never a control:
// "Parked until Tue 3 Mar · for the event on Sun 15 Mar" is a `neutral` chip
// with `Hourglass`; **Wake now** and **Change prep window** sit beside it as
// `ghost` `sm` buttons, for agents who may change the ticket's status.

import { useState } from "react";
import { AlarmClock, Hourglass, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/Button";
import { chipClass } from "@/components/Chip";
import { useAppSettings } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import type { HdTicketEvent } from "@/lib/helpdesk/desk-calendar-shared";
import { parkedChipLabel, type HdParkingView } from "@/lib/helpdesk/desk-calendar-park-shared";
import { getJson, sendJson } from "../api";
import { ParkDialog } from "./ParkDialog";

export function ParkedChip({
  number,
  parkedUntil,
  event,
  canChange,
  onChanged,
}: {
  number: number;
  parkedUntil: string;
  event: HdTicketEvent | null | undefined;
  canChange: boolean;
  onChanged: () => void;
}) {
  const { timezone: tz } = useAppSettings();
  const [busy, setBusy] = useState(false);
  const [prep, setPrep] = useState<HdParkingView | null>(null);
  const label = parkedChipLabel(parkedUntil, event ?? null, tz);

  async function wake() {
    setBusy(true);
    try {
      await sendJson(`/api/helpdesk/tickets/${number}/event/park`, "POST", { action: "wake" }, "Couldn't wake the ticket.");
      toast("ok", `#${number} is back in the queue.`);
      onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openPrep() {
    try {
      setPrep(await getJson<HdParkingView>(`/api/helpdesk/tickets/${number}/event/park`));
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1" data-testid="parked-bar">
      <span className={chipClass("neutral", "md", "max-w-full")} data-testid="parked-chip">
        <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      {canChange && (
        <span className="inline-flex flex-wrap items-center gap-1 print:hidden">
          <Button variant="ghost" size="sm" icon={<AlarmClock />} busy={busy} onClick={wake} data-testid="park-wake">
            Wake now
          </Button>
          <Button variant="ghost" size="sm" icon={<SlidersHorizontal />} onClick={openPrep} data-testid="park-change-prep">
            Change prep window
          </Button>
        </span>
      )}
      {prep && (
        <ParkDialog
          number={number}
          mode="prep"
          parking={prep}
          onClose={() => setPrep(null)}
          onSaved={() => {
            setPrep(null);
            onChanged();
          }}
        />
      )}
    </span>
  );
}
