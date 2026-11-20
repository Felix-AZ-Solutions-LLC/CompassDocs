"use client";

// Hold until the event (1.20.34, lib/helpdesk/desk-calendar-park; STYLEGUIDE
// §Helpdesk: the event calendar). One dialog for both entries: the Event
// block's **Hold until the event** (mode "park") and the Parked chip's
// **Change prep window** (mode "prep"). The prep window is a number of
// working days in the ticket's team calendar; the line under it says, from
// the server, when the ticket would wake, or the plain sentence that refuses
// it ("This event is too close to park: it would wake today.").

import { useEffect, useId, useState } from "react";
import { Hourglass } from "lucide-react";
import { Button } from "@/components/Button";
import { Field, TextInput } from "@/components/form";
import { Modal } from "@/components/Modal";
import { useAppSettings } from "@/components/SettingsProvider";
import { toast } from "@/components/Toasts";
import { timeLabel, zoneLabel } from "@/lib/helpdesk/desk-calendar-shared";
import { PARK_LIMITS, prepLabel, wakeDay, type HdParkingView } from "@/lib/helpdesk/desk-calendar-park-shared";
import { getJson, sendJson } from "../api";

export function ParkDialog({
  number,
  mode,
  parking,
  onClose,
  onSaved,
}: {
  number: number;
  mode: "park" | "prep";
  parking: HdParkingView;
  onClose: () => void;
  onSaved: (v: HdParkingView) => void;
}) {
  const { timezone: tz, time_format } = useAppSettings();
  const h12 = time_format === "12h";
  const titleId = useId();
  const [days, setDays] = useState(String(parking.prep_days));
  const [preview, setPreview] = useState<HdParkingView["preview"]>(parking.preview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const n = Number(days);
  const valid = days.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= PARK_LIMITS.prepDaysMax;

  // The server works the wake time out in the ticket's team calendar (working days and holidays): ask it as the number changes.
  useEffect(() => {
    if (!valid) return;
    const t = setTimeout(() => {
      getJson<HdParkingView>(`/api/helpdesk/tickets/${number}/event/park?prep_days=${n}`)
        .then((v) => setPreview(v.preview))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [number, n, valid]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) {
      setError(`The prep window is 0 to ${PARK_LIMITS.prepDaysMax} working days.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const own = n === parking.default_prep_days && parking.prep_override === null ? null : n;
      const v = await sendJson<HdParkingView>(
        `/api/helpdesk/tickets/${number}/event/park`,
        "POST",
        mode === "park" ? { action: "park", prep_days: own } : { action: "prep", prep_days: own },
        "Couldn't save that."
      );
      toast("ok", mode === "park" ? `#${number} is parked until its event.` : "Prep window changed.");
      onSaved(v);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const wake = preview?.wake_at ? `${wakeDay(preview.wake_at, tz)}, ${timeLabel(preview.wake_at, tz, h12)} (${zoneLabel(tz)})` : null;

  return (
    <Modal open onClose={onClose} labelledBy={titleId} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal sm:p-6">
      <form onSubmit={submit} noValidate data-testid="park-dialog">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Hourglass className="h-5 w-5 shrink-0 text-slate-700" aria-hidden />
          {mode === "park" ? `Hold #${number} until the event` : `Change the prep window of #${number}`}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          {mode === "park"
            ? "It goes on hold and leaves the queue. Its targets pause. It comes back to its owner, or its team, when it's time to prepare. A message from the requester brings it back sooner."
            : "How many working days before the event's setup is due the ticket comes back."}
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <Field label="Prep window (working days)" help={`0 to ${PARK_LIMITS.prepDaysMax}. The desk's is ${prepLabel(parking.default_prep_days)}. Weekends and holidays in the team's calendar don't count.`} size="sm">
            <TextInput type="number" inputMode="numeric" min={0} max={PARK_LIMITS.prepDaysMax} value={days} onChange={(e) => setDays(e.target.value)} data-testid="park-prep-days" />
          </Field>
          <p className="text-xs text-slate-500" aria-live="polite" data-testid="park-preview">
            {!valid ? `Enter 0 to ${PARK_LIMITS.prepDaysMax}.` : preview?.refusal ? null : wake ? `It wakes ${wake}.` : ""}
          </p>
          {valid && preview?.refusal && (
            <p className="notice-warn rounded-lg border px-3 py-2 text-sm" data-testid="park-refusal">
              {preview.refusal}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="notice-error mt-4 rounded-lg border px-3 py-2 text-sm">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={valid && !!preview?.refusal} data-testid="park-save">
            {mode === "park" ? "Hold until the event" : "Save prep window"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
