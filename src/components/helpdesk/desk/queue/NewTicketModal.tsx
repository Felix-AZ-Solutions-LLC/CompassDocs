"use client";

// "New ticket" (the queue's + button): an agent raises a ticket on
// someone's behalf (a phone call, a hallway question). POST
// /api/helpdesk/tickets; the new ticket opens in the pane.
//
// 1.20.21: with desk capability workflows.start, an optional Request type
// (the types the chosen requester could pick in Get help themselves, GET
// /api/helpdesk/tickets/request-types). Choosing one shows that type's own
// questions (Get help's FormFields, so they read and validate the same), the
// subject may be left empty (it is derived as Get help derives it), the team
// and priority default to the type's, and its workflow starts as the ticket
// is created (lib/helpdesk/workflow-start newTicketWorkflowCheck).

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button, iconButtonClass } from "@/components/Button";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdFormAnswers, type HdPriority, type HdTicket } from "@/lib/helpdesk/types";
import type { HdStartableType } from "@/lib/helpdesk/workflow-start-shared";
import { answerErrors, deriveSubject, FormFields } from "@/components/helpdesk/help/RequestForm";
import { getJson, itemOf, listOf, sendJson } from "../api";
import { useDeskCounts } from "../counts";
import { useCan } from "../me";
import { personOption, usePeople } from "../people";

export function NewTicketModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (number: number) => void }) {
  const titleId = useId();
  const people = usePeople();
  const can = useCan();
  const { counts } = useDeskCounts();
  const [requester, setRequester] = useState<number | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [team, setTeam] = useState<string>("");
  const [priority, setPriority] = useState<HdPriority>("normal");
  const [priorityTouched, setPriorityTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 1.20.21: the request type and its answers.
  const mayStart = can("workflows.start");
  const [types, setTypes] = useState<HdStartableType[] | null>(null);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [answers, setAnswers] = useState<HdFormAnswers>({});
  const refs = useRef(new Map<string, HTMLElement | null>());

  useEffect(() => {
    if (open) {
      setRequester(null);
      setSubject("");
      setBody("");
      setTeam("");
      setPriority("normal");
      setPriorityTouched(false);
      setTried(false);
      setError("");
      setTypes(null);
      setTypeId(null);
      setAnswers({});
    }
  }, [open]);

  // The types this requester could use themselves. A new requester starts from no type: the chosen
  // type's answers (prefilled from the previous person's directory entry) never carry over.
  useEffect(() => {
    setTypeId(null);
    setAnswers({});
    if (!open || !mayStart || !requester) {
      setTypes(null);
      return;
    }
    let live = true;
    getJson(`/api/helpdesk/tickets/request-types?requester_id=${requester}`, "Couldn't load the request types.")
      .then((r) => {
        if (!live) return;
        setTypes(listOf<HdStartableType>(r, "request_types"));
      })
      .catch(() => live && setTypes([]));
    return () => {
      live = false;
    };
  }, [open, mayStart, requester]);

  const type = types?.find((x) => x.id === typeId) ?? null;
  const who = people?.find((p) => p.id === requester);
  const formErrors = useMemo(() => (tried && type ? answerErrors(type.form, answers) : {}), [tried, type, answers]);
  const errs = {
    requester: !requester ? "Choose who the ticket is for." : undefined,
    // A request type's form names the ticket when the subject is left empty, as Get help does.
    subject: !subject.trim() && !type ? "Give the ticket a subject." : undefined,
  };

  function pickType(id: number | null) {
    setTypeId(id);
    const t = types?.find((x) => x.id === id);
    setAnswers(t ? { ...t.defaults } : {});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (errs.requester || errs.subject) return;
    if (type) {
      const bad = Object.keys(answerErrors(type.form, answers));
      if (bad.length) {
        refs.current.get(bad[0])?.focus();
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      const d = await sendJson(
        "/api/helpdesk/tickets",
        "POST",
        {
          requester_id: requester,
          subject: subject.trim() || (type ? deriveSubject(type, answers) : ""),
          body: body.trim(),
          // With a request type, "" leaves the team and the priority to the type.
          ...(team ? { team_id: Number(team) } : type ? {} : { team_id: null }),
          ...(type && !priorityTouched ? {} : { priority }),
          ...(type ? { request_type_id: type.id, answers } : {}),
        },
        "Couldn't create the ticket."
      );
      const t = itemOf<HdTicket>(d, "ticket");
      onCreated(t.number);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const typeHelp = type
    ? type.workflow
      ? `Starts ${type.workflow.title} (version ${type.workflow.version}) when the ticket is created.`
      : `No workflow: it's filed as a ${type.title} request.`
    : types && types.length === 0
      ? `No request type is available to ${who?.name || who?.username || "this person"}.`
      : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-surface p-5 shadow-modal"
    >
      <form onSubmit={submit} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            New ticket
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-600">Raise a ticket for someone who called or stopped by. They get the usual confirmation email.</p>
        <div className="mt-4 space-y-3">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Requester</p>
            {who ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span className="truncate font-medium text-slate-800">{who.name || who.username}</span>
                <button type="button" className="link text-xs" onClick={() => setRequester(null)}>
                  Change
                </button>
              </div>
            ) : (
              <EntityPicker
                options={(people ?? []).map(personOption)}
                onPick={(id) => setRequester(id)}
                label="Requester"
                placeholder="Search people…"
              />
            )}
            {tried && errs.requester && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {errs.requester}
              </p>
            )}
          </div>
          {mayStart && requester && (
            <Field label="Request type (optional)" help={typeHelp}>
              <Select value={typeId ?? ""} onChange={(e) => pickType(e.target.value ? Number(e.target.value) : null)} disabled={types === null}>
                <option value="">{types === null ? "Loading…" : "None"}</option>
                {(types ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {type && type.form.length > 0 && (
            <div className="flex flex-col gap-4 rounded-lg border border-slate-200 p-3">
              <FormFields
                fields={type.form}
                answers={answers}
                onChange={(key, value) => setAnswers((a) => ({ ...a, [key]: value }))}
                errors={formErrors}
                refs={refs}
                defaults={type.defaults}
                prefilledHelp={`From ${who?.name || who?.username || "the requester"}'s directory entry`}
              />
            </div>
          )}
          <Field
            label={type ? "Subject (optional)" : "Subject"}
            error={tried ? errs.subject : undefined}
            help={type && !subject.trim() ? `Left empty: "${deriveSubject(type, answers)}".` : undefined}
          >
            <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </Field>
          <Field label="What they need (optional)">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-28" maxLength={20000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Team">
              <Select value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">{type ? `The request type's${type.team_name ? ` (${type.team_name})` : ""}` : "Decide by the rules"}</option>
                {counts?.teams.map((t) => (
                  <option key={t.team_id} value={t.team_id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select
                value={type && !priorityTouched ? "" : priority}
                onChange={(e) => {
                  if (!e.target.value) {
                    setPriorityTouched(false);
                    return;
                  }
                  setPriority(e.target.value as HdPriority);
                  setPriorityTouched(true);
                }}
              >
                {type && <option value="">The request type&apos;s</option>}
                {HD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {HD_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {type?.workflow ? "Create and start" : "Create ticket"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
