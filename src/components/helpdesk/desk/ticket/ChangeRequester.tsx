"use client";

// "Change requester" on the requester strip (1.20.33, STYLEGUIDE §Requester
// strip): an agent who works the ticket makes someone else the requester, say
// to put right one an automation set wrongly. A 32px bordered icon button
// (UserRoundPen) beside Show details opens a Popover (role dialog): a
// people picker, or an email address for someone outside the workspace, and
// "Keep {name} as a CC". A ticket with no requester gets a secondary "Add
// requester" button with the same panel (review L10). From then on no rule
// changes the ticket's requester. POST /api/helpdesk/tickets/[number]/requester
// (lib/helpdesk/requester-change, the primitive automations use too); the
// change is an agents-only activity line and audited.

import { useId, useRef, useState } from "react";
import { UserPlus, UserRoundPen } from "lucide-react";
import { Button, buttonClass } from "@/components/Button";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, FormError, TextInput } from "@/components/form";
import { Popover } from "@/components/Popover";
import { toast } from "@/components/Toasts";
import { sendJson } from "../api";
import { personOption, usePeople } from "../people";

export function ChangeRequester({
  number,
  current,
  className = "",
  onChanged,
  add = false,
}: {
  number: number;
  current: string;
  className?: string;
  onChanged?: () => void;
  /** 1.20.33 review L10: a ticket with no requester: a secondary "Add requester" button instead of the icon. */
  add?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const title = add ? "Add requester" : "Change requester";
  return (
    <>
      {add ? (
        <button
          ref={btn}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="dialog"
          data-testid="add-requester"
          className={buttonClass("secondary", "sm", `print:hidden ${className}`)}
        >
          <UserPlus className="h-3.5 w-3.5" aria-hidden />
          Add requester
        </button>
      ) : (
        <button
          ref={btn}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Change requester"
          data-tt="Change requester"
          data-testid="change-requester"
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-surface text-slate-500 transition hover:bg-slate-50 hover:text-slate-700 print:hidden [&>svg]:h-4 [&>svg]:w-4 ${className}`}
        >
          <UserRoundPen aria-hidden />
        </button>
      )}
      <Popover open={open} onClose={() => setOpen(false)} triggerRef={btn} role="dialog" label={title} align="end" width="w-80" padding="p-3">
        {open && (
          <ChangeRequesterForm
            number={number}
            current={current}
            title={title}
            onDone={() => {
              setOpen(false);
              onChanged?.();
            }}
            onCancel={() => setOpen(false)}
          />
        )}
      </Popover>
    </>
  );
}

function ChangeRequesterForm({ number, current, title, onDone, onCancel }: { number: number; current: string; title: string; onDone: () => void; onCancel: () => void }) {
  const people = usePeople();
  const [userId, setUserId] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [keepCc, setKeepCc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const headingId = useId();
  const picked = userId ? people?.find((p) => p.id === userId) : undefined;
  const pickedName = picked ? picked.name || picked.username : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId && !email.trim()) {
      setError("Pick a person, or type an email address.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ changed: boolean; cc?: { kept: boolean } }>(
        `/api/helpdesk/tickets/${number}/requester`,
        "POST",
        { ...(userId ? { user_id: userId } : { email: email.trim() }), keep_cc: keepCc },
        "Couldn't change the requester."
      );
      const who = pickedName || email.trim();
      toast("ok", r.changed ? `${who} is now the requester.${keepCc && r.cc && !r.cc.kept ? ` ${current} couldn't be kept as a CC.` : ""}` : `${who} already is the requester.`);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby={headingId} data-testid="change-requester-form">
      <p id={headingId} className="text-sm font-semibold text-slate-900">
        {title}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">Replies and notices go to the new requester from now on, and rules no longer change it.</p>
      <div className="mt-3 space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500">Person</p>
          {userId ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <span className="truncate font-medium text-slate-800">{pickedName}</span>
              <button type="button" className="link text-xs" onClick={() => setUserId(null)}>
                Change<span className="sr-only"> the person</span>
              </button>
            </div>
          ) : (
            <EntityPicker
              options={(people ?? []).map(personOption)}
              onPick={(id) => {
                setUserId(id);
                setEmail("");
              }}
              label="New requester"
              placeholder={people === null ? "Loading people…" : "Search people…"}
              disabled={people === null}
            />
          )}
        </div>
        {!userId && (
          <Field label="Or an email address" help="Someone outside the workspace, while outside senders are accepted.">
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" autoComplete="off" />
          </Field>
        )}
        {current && (
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={keepCc} onChange={(e) => setKeepCc(e.target.checked)} />
            Keep {current} as a CC
          </label>
        )}
        <FormError>{error}</FormError>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" busy={busy}>
          {title}
        </Button>
      </div>
    </form>
  );
}
