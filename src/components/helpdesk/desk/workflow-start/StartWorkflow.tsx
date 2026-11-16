"use client";

// Start a workflow from the desk (1.20.21, lib/helpdesk/workflow-start).
//
//   useStartWorkflowMenu(ticket)   the ticket's … menu item "Start a
//     workflow…" (desk capability workflows.start), with its dialog. Not on a
//     solved, closed or merged ticket, nor on a workflow task or another
//     child ticket (the server refuses those too).
//   StartWorkflowDialog            on the house Modal: the outcome first (a
//     neutral strip saying whether the run lives on this ticket or on a new
//     request linked to it, decided by the server), then the request type
//     (those that start a published workflow and that the requester could
//     use themselves), then that type's own questions, rendered by Get help's
//     FormFields so they read and validate the same. The primary says what
//     will happen ("Start on this ticket" / "Open a request and start").
//
// One client_start_id per opening: a double-click or a retry sends the same
// key and the server starts nothing twice. If the ticket changed meanwhile the
// server answers 409 and the dialog reloads its outcome before anything is
// done.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { TicketPlus, Workflow, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button, iconButtonClass } from "@/components/Button";
import { Field, FormError, SectionEmpty, Select } from "@/components/form";
import { MenuItem } from "@/components/Popover";
import { LoadingRow } from "@/components/Spinner";
import { toast } from "@/components/Toasts";
import type { HdFormAnswers } from "@/lib/helpdesk/types";
import {
  startButtonLabel,
  startModeSentence,
  WORKFLOW_START_CODES,
  type HdStartableType,
  type HdStartWorkflowOptions,
  type HdStartWorkflowResult,
} from "@/lib/helpdesk/workflow-start-shared";
import { answerErrors, deriveSubject, FormFields } from "@/components/helpdesk/help/RequestForm";
import { ApiError, getJson, sendJson } from "../api";
import { useCan } from "../me";
import { useQueue } from "../queue/QueueLayout";

interface TicketLike {
  number: number;
  status: string;
  source?: string;
  merged_into?: number | null;
  parent_ticket_id?: number | null;
}

/** A fresh idempotency key (16 to 64 of [A-Za-z0-9_-]). */
export function newStartId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 40);
}

/** May this ticket offer "Start a workflow…" (the server's startRefusal, as the pane can see it)? */
export function canStartFrom(t: TicketLike): boolean {
  return t.status !== "solved" && t.status !== "closed" && !t.merged_into && !t.parent_ticket_id && t.source !== "workflow";
}

/** The … menu's "Start a workflow…" and its dialog; `any` says whether there is an item. */
export function useStartWorkflowMenu(
  t: TicketLike,
  opts: { onStarted?: (r: HdStartWorkflowResult) => void } = {}
): { any: boolean; items: (close: () => void) => ReactNode; dialogs: ReactNode } {
  const can = useCan();
  const [open, setOpen] = useState(false);
  const any = can("workflows.start") && canStartFrom(t);
  return {
    any,
    items: (close) =>
      any ? (
        <MenuItem icon={<Workflow />} onClick={() => { close(); setOpen(true); }}>
          Start a workflow…
        </MenuItem>
      ) : null,
    dialogs: any ? <StartWorkflowDialog open={open} onClose={() => setOpen(false)} number={t.number} onStarted={opts.onStarted} /> : null,
  };
}

export function StartWorkflowDialog({
  open,
  onClose,
  number,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  onStarted?: (r: HdStartWorkflowResult) => void;
}) {
  const titleId = useId();
  const ledeId = useId();
  const router = useRouter();
  const { qs } = useQueue();
  const can = useCan();
  const [opts, setOpts] = useState<HdStartWorkflowOptions | null>(null);
  const [loadError, setLoadError] = useState("");
  const [typeId, setTypeId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<HdFormAnswers>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const startId = useRef("");
  const refs = useRef(new Map<string, HTMLElement | null>());

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const o = await getJson<HdStartWorkflowOptions>(`/api/helpdesk/tickets/${number}/start-workflow`, "Couldn't load the request types.");
      setOpts(o);
      return o;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, [number]);

  useEffect(() => {
    if (!open) return;
    // One key per opening: every try from here on sends it.
    startId.current = newStartId();
    setOpts(null);
    setTypeId(null);
    setAnswers({});
    setTried(false);
    setBusy(false);
    setError("");
    void load();
  }, [open, load]);

  const type: HdStartableType | null = opts?.types.find((x) => x.id === typeId) ?? null;
  const errors = useMemo(() => (tried && type ? answerErrors(type.form, answers) : {}), [tried, type, answers]);
  const requester = opts?.requester.name ?? "the requester";

  function pick(id: number | null) {
    setTypeId(id);
    const t = opts?.types.find((x) => x.id === id);
    // The requester's directory prefill, as Get help fills it for them.
    setAnswers(t ? { ...t.defaults } : {});
    setTried(false);
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !opts) return;
    setTried(true);
    setError("");
    if (!type) {
      refs.current.get("__type")?.focus();
      return;
    }
    const bad = Object.keys(answerErrors(type.form, answers));
    if (bad.length) {
      refs.current.get(bad[0])?.focus();
      return;
    }
    setBusy(true);
    try {
      const r = await sendJson<HdStartWorkflowResult>(
        `/api/helpdesk/tickets/${number}/start-workflow`,
        "POST",
        {
          request_type_id: type.id,
          answers,
          client_start_id: startId.current,
          expect: opts.mode,
          ...(opts.mode === "new" ? { subject: deriveSubject(type, answers) } : {}),
        },
        "Couldn't start the workflow."
      );
      const n = r.request.number;
      if (!r.started) toast("error", r.mode === "this" ? `#${n} is a ${type.title} request now, but its workflow didn't start.` : `Request #${n} was opened, but its workflow didn't start.`);
      else if (r.mode === "this") toast("ok", `${r.workflow?.title ?? "The workflow"} started on #${n}.`);
      else toast("ok", `Request #${n} opened and ${r.workflow?.title ?? "its workflow"} started.`, { action: { label: `Open #${n}`, onClick: () => router.push(`/desk/tickets/${n}${qs}`) } });
      onStarted?.(r);
      onClose();
    } catch (err) {
      // The ticket changed while the dialog was open: show the new outcome before anything is done.
      if (err instanceof ApiError && err.code === WORKFLOW_START_CODES.modeChanged) await load();
      if (err instanceof ApiError && err.code === WORKFLOW_START_CODES.notEligible) await load();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const mode = opts?.mode ?? "this";
  const ready = !!opts && opts.eligible && opts.types.length > 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={ledeId}
      className="max-h-[calc(100vh-2rem)] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal sm:p-6"
    >
      <form onSubmit={submit} noValidate data-testid="start-workflow-dialog">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <Workflow className="h-5 w-5 text-slate-700" aria-hidden />
            Start a workflow
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <p id={ledeId} className="mt-1 text-sm text-slate-600">
          {opts
            ? `For ${requester}, on their behalf: its approvals, tasks and notices go as if they had asked in ${opts.requester.portal ? "the customer portal" : "Get help"}.`
            : "Start a request type's workflow for this ticket's requester."}
        </p>

        {!opts && !loadError && <LoadingRow className="py-10" />}
        <FormError className="mt-4">{loadError}</FormError>

        {opts && !opts.eligible && <p className="notice-warn mt-4 rounded-lg border px-3 py-2 text-sm">{opts.reason}</p>}

        {opts && opts.eligible && (
          <>
            {/* What will happen, before anything is chosen: decided by the server, re-checked as it starts. */}
            <div role="note" data-testid="start-workflow-mode" data-mode={mode} className="mt-4 flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
              {mode === "this" ? <Workflow className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden /> : <TicketPlus className="mt-0.5 h-4 w-4 shrink-0 text-compass-600" aria-hidden />}
              <span>
                <span className="block font-semibold text-slate-800">{mode === "this" ? "On this ticket" : "On a new request"}</span>
                {startModeSentence(mode, opts.ticket, requester)}
              </span>
            </div>

            {opts.types.length === 0 ? (
              <SectionEmpty
                className="mt-4"
                action={can("request_types.manage") ? { href: "/desk/settings/request-types", label: "Request types" } : undefined}
              >
                No request type starts a workflow for {requester}. One shows here when it&apos;s switched on, its workflow is published, {requester} could
                choose it in {opts.requester.portal ? "the customer portal" : "Get help"}
                {mode === "new" ? ", and its team is one of yours" : ""}.
              </SectionEmpty>
            ) : (
              <div className="mt-4 flex flex-col gap-5">
                <Field
                  label="Request type"
                  error={tried && !type ? "Choose a request type." : undefined}
                  help={type?.workflow ? `Starts ${type.workflow.title} (version ${type.workflow.version}, ${type.workflow.steps} ${type.workflow.steps === 1 ? "step" : "steps"})${type.team_name ? ` · ${type.team_name}` : ""}.` : undefined}
                >
                  <Select
                    ref={(el) => {
                      refs.current.set("__type", el);
                    }}
                    data-autofocus=""
                    value={typeId ?? ""}
                    onChange={(e) => pick(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">Choose…</option>
                    {opts.types.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title}
                      </option>
                    ))}
                  </Select>
                </Field>
                {type?.description && <p className="-mt-3 text-sm text-slate-600">{type.description}</p>}
                {type && type.form.length > 0 && (
                  <FormFields
                    fields={type.form}
                    answers={answers}
                    onChange={(key, value) => setAnswers((a) => ({ ...a, [key]: value }))}
                    errors={errors}
                    refs={refs}
                    defaults={type.defaults}
                    prefilledHelp={`From ${requester}'s directory entry`}
                  />
                )}
                {type && type.form.length === 0 && <p className="text-sm text-slate-500">This request type asks no questions.</p>}
              </div>
            )}
          </>
        )}

        {opts && <FormError className="mt-4">{error}</FormError>}
        <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {ready && (
            <Button type="submit" busy={busy} icon={mode === "this" ? <Workflow /> : <TicketPlus />}>
              {startButtonLabel(mode)}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
