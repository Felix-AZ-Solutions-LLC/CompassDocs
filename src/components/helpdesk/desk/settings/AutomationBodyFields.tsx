"use client";

// Settings → Automations, 1.20.33: the rule editor's subject-and-body parts
// (lib/helpdesk/automation-body-shared; STYLEGUIDE §Helpdesk: automations,
// subject and body).
//
//   If    "Subject and body": four phrase lists (one phrase a line), then a
//         closed "Advanced: patterns" with Subject / Body matches pattern,
//         each with Match case and a "Try it" box.
//   Then  "Change the requester": leave it, to a person (a workspace person
//         or an address), or from the message (where to look, the required
//         "Only for messages from", optional domains, keep the sender as a
//         CC, allow desk agents).
//         "Copy a value into a field": up to 10 rows, each from the message
//         or the subject, after a label or with a pattern (with its own Try
//         it), into a custom field of the rule's teams or as a tag.
//
// "Try it" runs the same engine and the same functions as the server's rules
// (loaded when the box is first used), in the browser: nothing is sent.

import { useEffect, useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button, iconButtonClass } from "@/components/Button";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, Select, TextInput, Textarea } from "@/components/form";
import { Segmented } from "@/components/Segmented";
import { Tooltip } from "@/components/Tooltip";
import { chipClass } from "@/components/Chip";
import { AUTOMATION_BODY_LIMITS, DEFAULT_REQUESTER_LABELS } from "@/lib/helpdesk/automation-body-limits";
import { CUSTOM_FIELD_KIND_LABEL } from "@/lib/helpdesk/custom-fields-shared";
import type { HdAutomationActions, HdAutomationConditions, HdAutomationCopy, HdFormFieldType, HdFormOption } from "@/lib/helpdesk/types";
import { personOption, usePeople } from "../people";

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const list = (s: string) => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const SUMMARY = "cursor-pointer text-sm font-semibold text-slate-800";
const BOX = "rounded-lg border border-slate-200 p-3";

// --- If: subject and body --------------------------------------------------------------------

/** The editor's text for the subject and body conditions. */
export interface BodyConditionsDraft {
  subject_contains: string;
  subject_not_contains: string;
  body_contains: string;
  body_not_contains: string;
  subject_pattern: string;
  subject_case: boolean;
  body_pattern: string;
  body_case: boolean;
}

export function bodyConditionsDraft(c: HdAutomationConditions | undefined): BodyConditionsDraft {
  return {
    subject_contains: (c?.subject_contains ?? []).join("\n"),
    subject_not_contains: (c?.subject_not_contains ?? []).join("\n"),
    body_contains: (c?.body_contains ?? []).join("\n"),
    body_not_contains: (c?.body_not_contains ?? []).join("\n"),
    subject_pattern: c?.subject_pattern?.pattern ?? "",
    subject_case: c?.subject_pattern?.match_case === true,
    body_pattern: c?.body_pattern?.pattern ?? "",
    body_case: c?.body_pattern?.match_case === true,
  };
}

/** The conditions the draft stands for (only the ones in use). */
export function bodyConditionsOf(d: BodyConditionsDraft): HdAutomationConditions {
  const out: HdAutomationConditions = {};
  for (const k of ["subject_contains", "subject_not_contains", "body_contains", "body_not_contains"] as const) {
    const v = lines(d[k]);
    if (v.length) out[k] = v;
  }
  if (d.subject_pattern.trim()) out.subject_pattern = { pattern: d.subject_pattern, ...(d.subject_case ? { match_case: true } : {}) };
  if (d.body_pattern.trim()) out.body_pattern = { pattern: d.body_pattern, ...(d.body_case ? { match_case: true } : {}) };
  return out;
}

export function SubjectBodyConditions({ value, onChange }: { value: BodyConditionsDraft; onChange: (next: BodyConditionsDraft) => void }) {
  const set = (k: keyof BodyConditionsDraft, v: string | boolean) => onChange({ ...value, [k]: v });
  const hasPattern = !!(value.subject_pattern.trim() || value.body_pattern.trim());
  // Closed by default; opened when the rule has a pattern (on load), and then left as the admin leaves it.
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    if (hasPattern) setAdvanced(true);
  }, [hasPattern]);
  const phrase = (k: "subject_contains" | "subject_not_contains" | "body_contains" | "body_not_contains", label: string, placeholder: string) => (
    <Field label={label}>
      <Textarea value={value[k]} onChange={(e) => set(k, e.target.value)} rows={2} className="h-16" placeholder={placeholder} spellCheck={false} />
    </Field>
  );
  return (
    <fieldset className={BOX} data-testid="rule-subject-body">
      <legend className="px-1 text-xs font-medium text-slate-500">Subject and body</legend>
      <p className="mb-2 text-xs text-slate-500">One phrase a line. Any case, exact text (part of a word counts). The body is the message the rule reads, as agents see it.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {phrase("subject_contains", "Subject contains any of", "[Web form]")}
        {phrase("subject_not_contains", "Subject doesn't contain", "Out of office")}
        {phrase("body_contains", "Body contains any of", "Submitted via the web form")}
        {phrase("body_not_contains", "Body doesn't contain", "This is a test")}
      </div>
      <details className="mt-3" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
        <summary className={SUMMARY}>Advanced: patterns</summary>
        <p className="mt-1 text-xs text-slate-500">
          Regular expressions (RE2: no lookarounds or backreferences), up to {AUTOMATION_BODY_LIMITS.pattern} characters, matched on the first 100 KB of the body. Any case unless you tick Match case.
        </p>
        <div className="mt-3 space-y-4">
          <PatternField label="Subject matches pattern" pattern={value.subject_pattern} matchCase={value.subject_case} onPattern={(v) => set("subject_pattern", v)} onCase={(v) => set("subject_case", v)} />
          <PatternField label="Body matches pattern" pattern={value.body_pattern} matchCase={value.body_case} onPattern={(v) => set("body_pattern", v)} onCase={(v) => set("body_case", v)} />
        </div>
      </details>
    </fieldset>
  );
}

function PatternField({
  label,
  pattern,
  matchCase,
  onPattern,
  onCase,
  groups,
}: {
  label: string;
  pattern: string;
  matchCase: boolean;
  onPattern: (v: string) => void;
  onCase: (v: boolean) => void;
  /** "Copy a value" asks for exactly one capture group. */
  groups?: 1;
}) {
  return (
    <div>
      <Field label={label} help={groups ? "One group in brackets around the value to copy, like Asset tag:\\s*(\\S+)." : undefined}>
        <TextInput value={pattern} onChange={(e) => onPattern(e.target.value)} maxLength={AUTOMATION_BODY_LIMITS.pattern} className="font-mono" spellCheck={false} placeholder={groups ? "Asset tag:\\s*(\\S+)" : "^\\[ALERT\\]"} />
      </Field>
      <label className="mt-1.5 inline-flex items-center gap-1.5 text-sm text-slate-700">
        <input type="checkbox" checked={matchCase} onChange={(e) => onCase(e.target.checked)} />
        Match case
      </label>
      <PatternTester pattern={pattern} matchCase={matchCase} groups={groups} />
    </div>
  );
}

type TryResult = { error: string } | { matched: boolean; match: string; groups: (string | null)[] };

/**
 * "Try it" (STYLEGUIDE §Helpdesk: automations, subject and body): paste sample text, see whether the pattern matches
 * and what each capture group caught. The same engine and functions as the server's rules, run in the browser.
 */
export function PatternTester({ pattern, matchCase, groups }: { pattern: string; matchCase: boolean; groups?: 1 }) {
  const id = useId();
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<TryResult | null>(null);
  useEffect(() => {
    if (!sample || !pattern.trim()) {
      setResult(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void import("@/lib/helpdesk/automation-body-shared").then((m) => live && setResult(m.tryPattern(pattern, matchCase, sample)));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pattern, matchCase, sample]);
  return (
    <details className="mt-2" data-testid="pattern-tester">
      <summary className="cursor-pointer text-xs font-medium text-compass-700">Try it</summary>
      <div className="mt-2 rounded-lg border border-slate-200 bg-canvas p-3">
        <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-500">
          Sample text
        </label>
        <Textarea
          id={id}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          rows={3}
          className="h-20 font-mono text-xs"
          maxLength={AUTOMATION_BODY_LIMITS.sample}
          spellCheck={false}
          placeholder="Paste a subject or a message here"
        />
        <div aria-live="polite" className="mt-2 text-xs" data-testid="pattern-tester-result">
          {!pattern.trim() ? (
            <p className="text-slate-500">Write a pattern above to try it.</p>
          ) : !sample ? (
            <p className="text-slate-500">Paste sample text to see whether it matches. Nothing is sent anywhere.</p>
          ) : !result ? null : "error" in result ? (
            <p className="text-red-600">{result.error}</p>
          ) : result.matched ? (
            <>
              <p className="font-medium text-slate-800">
                <span className={chipClass("ok", "sm")}>Matches</span> <span className="ml-1 font-mono">{result.match || "(an empty match)"}</span>
              </p>
              {result.groups.length > 0 ? (
                <ol className="mt-1 space-y-0.5 text-slate-700" aria-label="Capture groups">
                  {result.groups.map((g, i) => (
                    <li key={i}>
                      Group {i + 1}: {g === null ? <span className="text-slate-500">took no part</span> : <span className="font-mono">{g || "(empty)"}</span>}
                    </li>
                  ))}
                </ol>
              ) : groups ? (
                <p className="mt-1 ink-warn">It has no group in brackets, so there is nothing to copy.</p>
              ) : null}
              {groups && result.groups.length > 1 && <p className="mt-1 ink-warn">It has {result.groups.length} groups; a copy needs exactly one. Write the others as (?:…).</p>}
            </>
          ) : (
            <p className="text-slate-700">
              <span className={chipClass("neutral", "sm")}>No match</span>
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

// --- Then: change the requester ----------------------------------------------------------------

export type RequesterMode = "none" | "person" | "message";

export interface RequesterDraft {
  mode: RequesterMode;
  user_id: number | null;
  email: string;
  /** The name to show for an address (optional). */
  name: string;
  keep_cc_person: boolean;
  find: "label" | "first";
  labels: string;
  senders: string;
  domains: string;
  keep_cc: boolean;
  allow_agents: boolean;
}

export function requesterDraft(a: HdAutomationActions | undefined): RequesterDraft {
  const s = a?.requester_set;
  const m = a?.requester_from_message;
  return {
    mode: s ? "person" : m ? "message" : "none",
    user_id: s?.user_id ?? null,
    email: s?.email ?? "",
    name: s?.name ?? "",
    keep_cc_person: s?.keep_cc === true,
    find: m?.find ?? "label",
    labels: (m?.labels ?? DEFAULT_REQUESTER_LABELS).join(", "),
    senders: (m?.senders ?? []).join("\n"),
    domains: (m?.domains ?? []).join(", "),
    keep_cc: m?.keep_cc === true,
    allow_agents: m?.allow_agents === true,
  };
}

/** The actions the draft stands for, and the problem a save would be refused for (checked in the browser first). */
/** 1.20.33 review M3: the events a rule may change the requester on (lib/helpdesk/automations REQUESTER_ACTION_EVENTS). */
export const REQUESTER_EVENTS: readonly string[] = ["ticket_created", "requester_message"];
const EVENT_ERROR = 'Change the requester only on "A ticket is created" or "The requester sends a message".';

export function requesterActionsOf(d: RequesterDraft, event?: string): { actions: Pick<HdAutomationActions, "requester_set" | "requester_from_message">; error?: string } {
  if (d.mode !== "none" && event && !REQUESTER_EVENTS.includes(event)) return { actions: {}, error: EVENT_ERROR };
  if (d.mode === "person") {
    if (d.user_id) return { actions: { requester_set: { user_id: d.user_id, ...(d.keep_cc_person ? { keep_cc: true } : {}) } } };
    if (d.email.trim()) return { actions: { requester_set: { email: d.email.trim(), ...(d.name.trim() ? { name: d.name.trim() } : {}), ...(d.keep_cc_person ? { keep_cc: true } : {}) } } };
    return { actions: {}, error: "Pick the person to make the requester, or type their email address." };
  }
  if (d.mode === "message") {
    const senders = list(d.senders);
    const labels = list(d.labels);
    const domains = list(d.domains);
    return {
      actions: {
        requester_from_message: {
          find: d.find,
          ...(d.find === "label" ? { labels: labels.length ? labels : [...DEFAULT_REQUESTER_LABELS] } : {}),
          senders,
          ...(domains.length ? { domains } : {}),
          ...(d.keep_cc ? { keep_cc: true } : {}),
          ...(d.allow_agents ? { allow_agents: true } : {}),
        },
      },
      ...(senders.length ? {} : { error: "List who these messages come from: the forwarding address, alert system or web form (or its @domain)." }),
    };
  }
  return { actions: {} };
}

export function RequesterAction({
  value,
  onChange,
  names,
  tried,
  error,
  eventAllowed = true,
}: {
  value: RequesterDraft;
  onChange: (next: RequesterDraft) => void;
  /** The rule's When is one a rule may change the requester on (a new ticket, the requester's message). */
  eventAllowed?: boolean;
  /** Names of people rules already name (so one who is no longer in the picker still reads by name). */
  names: { id: number; name: string }[];
  tried: boolean;
  error?: string;
}) {
  const people = usePeople();
  const set = <K extends keyof RequesterDraft>(k: K, v: RequesterDraft[K]) => onChange({ ...value, [k]: v });
  const fromPicker = value.user_id ? people?.find((p) => p.id === value.user_id) : undefined;
  const fromNames = value.user_id ? names.find((p) => p.id === value.user_id) : undefined;
  const chosen = fromPicker ?? fromNames;
  const chosenName: string = fromPicker ? fromPicker.name || fromPicker.username : (fromNames?.name ?? "");
  const gone = !!value.user_id && people !== null && !chosen;
  return (
    <fieldset className={`${BOX} sm:col-span-2`} data-testid="rule-requester">
      <legend className="px-1 text-xs font-medium text-slate-500">Change the requester</legend>
      <Segmented
        label="Change the requester"
        size="sm"
        className="flex-wrap"
        value={value.mode}
        onChange={(m) => set("mode", m)}
        options={[
          { value: "none", label: "Leave as it is" },
          { value: "person", label: "To a person" },
          { value: "message", label: "From the message" },
        ]}
      />
      <p className="mt-2 text-xs text-slate-500">
        Only when a ticket is created or the requester sends a message. Once an agent changes a ticket&apos;s requester by hand, rules leave it.
      </p>
      {!eventAllowed && value.mode !== "none" && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {EVENT_ERROR}
        </p>
      )}
      {value.mode === "person" && (
        <div className="mt-3 space-y-3">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Person</p>
            {value.user_id ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                {gone ? (
                  <span className={chipClass("warn", "md")}>A deleted person</span>
                ) : (
                  <span className="truncate font-medium text-slate-800">{chosenName || "Loading…"}</span>
                )}
                <button type="button" className="link text-xs" onClick={() => set("user_id", null)}>
                  Change<span className="sr-only"> the person</span>
                </button>
              </div>
            ) : (
              <EntityPicker
                options={(people ?? []).map(personOption)}
                onPick={(id) => onChange({ ...value, user_id: id, email: "" })}
                label="Person to make the requester"
                placeholder={people === null ? "Loading people…" : "Search people…"}
                disabled={people === null}
              />
            )}
          </div>
          {!value.user_id && (
            <Field label="Or an email address (optional)" help="Someone outside the workspace becomes the requester as inbound email would take them in, while Desk settings → Email accepts outside senders.">
              <TextInput type="email" value={value.email} onChange={(e) => set("email", e.target.value)} placeholder="jane@example.com" autoComplete="off" />
            </Field>
          )}
          {!value.user_id && value.email.trim() && (
            <Field label="Name (optional)" help="Shown for someone outside the workspace. Empty: their address.">
              <TextInput value={value.name} onChange={(e) => set("name", e.target.value)} maxLength={200} placeholder="Jane Doe" autoComplete="off" />
            </Field>
          )}
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={value.keep_cc_person} onChange={(e) => set("keep_cc_person", e.target.checked)} />
            Keep the previous requester as a CC
          </label>
        </div>
      )}
      {value.mode === "message" && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-500">
            For messages a forwarder sends on someone&apos;s behalf (a web form, an alert system, a shared mailbox): the person named in the message becomes the requester, so replies go to them. Someone with no
            account is taken in as inbound email would take them in.
          </p>
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-slate-500">Where to look</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                <input type="radio" name="requester-find" checked={value.find === "label"} onChange={() => set("find", "label")} />
                After a label, on the same line
              </label>
              <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                <input type="radio" name="requester-find" checked={value.find === "first"} onChange={() => set("find", "first")} />
                The first address in the message
              </label>
            </div>
          </fieldset>
          {value.find === "label" && (
            <Field label="Labels" help="Comma-separated, such as From:, Email: or Reply-To:. A label starts its line (after any >); the first line that starts with one decides.">
              <TextInput value={value.labels} onChange={(e) => set("labels", e.target.value)} placeholder="From:, Email:" />
            </Field>
          )}
          <Field
            label="Only for messages from"
            error={tried ? error : undefined}
            help="Required. The forwarding address, alert system or web form, one a line: whole addresses or @domain (never a free-mail domain such as @gmail.com). The rule does nothing for a message from anyone else, so nobody can write “From:” with someone else's address and take over a ticket and its replies."
          >
            <Textarea value={value.senders} onChange={(e) => set("senders", e.target.value)} rows={2} className="h-16" placeholder={"forms@acme.example\n@alerts.acme.example"} spellCheck={false} />
          </Field>
          <Field label="Only accept addresses at (optional)" help="Domains, comma-separated, like @acme.example. Empty: any domain.">
            <TextInput value={value.domains} onChange={(e) => set("domains", e.target.value)} placeholder="@acme.example" spellCheck={false} />
          </Field>
          <div className="flex flex-col gap-1.5">
            <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" checked={value.keep_cc} onChange={(e) => set("keep_cc", e.target.checked)} />
              Keep the original sender as a CC
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" checked={value.allow_agents} onChange={(e) => set("allow_agents", e.target.checked)} />
              Allow addresses of desk agents
            </label>
          </div>
          <p className="text-xs text-slate-500">
            Never the desk&apos;s own addresses or the sender&apos;s, never a desk agent&apos;s unless allowed, and never an email whose sender didn&apos;t pass the sender check. In
            &ldquo;Name &lt;address&gt;&rdquo; only the address in brackets counts. When that address can&apos;t be used, the requester stays and the ticket notes why. Acknowledgements
            to requesters found this way are limited per address and per rule.
          </p>
        </div>
      )}
      {value.mode === "person" && tried && error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </fieldset>
  );
}

// --- Then: copy a value into a field -------------------------------------------------------------

/** A custom field a rule can copy into (GET /api/helpdesk/admin/automations `fields`). */
export interface RuleField {
  key: string;
  label: string;
  type: HdFormFieldType;
  options: HdFormOption[];
  all_teams: boolean;
  team_ids: number[];
  archived: boolean;
}

export interface CopyDraft {
  from: "body" | "subject";
  how: "label" | "pattern";
  label: string;
  pattern: string;
  match_case: boolean;
  /** A field's key, or "" with tag. */
  field_key: string;
  tag: boolean;
  only_if_empty: boolean;
}

export const newCopy = (): CopyDraft => ({ from: "body", how: "label", label: "", pattern: "", match_case: false, field_key: "", tag: false, only_if_empty: true });

export function copyDrafts(a: HdAutomationActions | undefined): CopyDraft[] {
  return (a?.copy_values ?? []).map((c) => ({
    from: c.from,
    how: c.pattern ? "pattern" : "label",
    label: c.label ?? "",
    pattern: c.pattern ?? "",
    match_case: c.match_case === true,
    field_key: c.field_key ?? "",
    tag: c.tag === true,
    only_if_empty: c.only_if_empty !== false,
  }));
}

/** The copy actions the rows stand for, and the first row's problem (checked in the browser before a save). */
export function copyValuesOf(rows: CopyDraft[]): { copies: HdAutomationCopy[]; error?: string } {
  const copies: HdAutomationCopy[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const at = rows.length > 1 ? `Copy ${i + 1}: ` : "";
    const found = r.how === "label" ? r.label.trim() : r.pattern.trim();
    if (!found) return { copies, error: `${at}${r.how === "label" ? "write the label before the value, like Asset tag:" : "write the pattern"}.` };
    if (!r.field_key && !r.tag) return { copies, error: `${at}pick the field to copy into, or Add as a tag.` };
    copies.push({
      from: r.from,
      ...(r.how === "label" ? { label: r.label.trim() } : { pattern: r.pattern }),
      ...(r.match_case ? { match_case: true } : {}),
      ...(r.field_key ? { field_key: r.field_key } : { tag: true }),
      ...(r.field_key && !r.only_if_empty ? { only_if_empty: false } : {}),
    });
  }
  return { copies };
}

export function CopyValuesAction({
  rows,
  onChange,
  fields,
  tried,
  error,
}: {
  rows: CopyDraft[];
  onChange: (next: CopyDraft[]) => void;
  /** The fields this rule may copy into (its desk department's teams' and all teams'). */
  fields: RuleField[];
  tried: boolean;
  error?: string;
}) {
  const setRow = (i: number, patch: Partial<CopyDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const full = rows.length >= AUTOMATION_BODY_LIMITS.copies;
  const add = (
    <Button variant="secondary" size="sm" icon={<Plus />} disabled={full} onClick={() => onChange([...rows, newCopy()])}>
      Add a value to copy
    </Button>
  );
  return (
    <fieldset className={`${BOX} sm:col-span-2`} data-testid="rule-copy-values">
      <legend className="px-1 text-xs font-medium text-slate-500">Copy a value into a field</legend>
      <p className="mb-2 text-xs text-slate-500">
        Take a value from the message or the subject and put it in one of the ticket&apos;s fields, or add it as a tag. A value that doesn&apos;t fit the field (not one of its options, not a number or a
        date) is skipped and noted on the ticket.
      </p>
      {rows.length > 0 && (
        <ol className="space-y-3">
          {rows.map((r, i) => {
            const target = fields.find((f) => f.key === r.field_key);
            const gone = !!r.field_key && !target;
            return (
              <li key={i} className="rounded-lg border border-slate-200 p-3" aria-label={`Copy ${i + 1}`}>
                <div className="flex items-start gap-2">
                  <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                    <Field label="From">
                      <Select value={r.from} onChange={(e) => setRow(i, { from: e.target.value as CopyDraft["from"] })}>
                        <option value="body">The message</option>
                        <option value="subject">The subject</option>
                      </Select>
                    </Field>
                    <Field label="Find it">
                      <Select value={r.how} onChange={(e) => setRow(i, { how: e.target.value as CopyDraft["how"] })}>
                        <option value="label">Text after a label</option>
                        <option value="pattern">With a pattern</option>
                      </Select>
                    </Field>
                    {r.how === "label" ? (
                      <Field label="Label" help="The rest of that line is copied, trimmed." className="sm:col-span-2">
                        <TextInput value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} maxLength={AUTOMATION_BODY_LIMITS.label} placeholder="Asset tag:" />
                      </Field>
                    ) : (
                      <div className="sm:col-span-2">
                        <PatternField label="Pattern" groups={1} pattern={r.pattern} matchCase={r.match_case} onPattern={(v) => setRow(i, { pattern: v })} onCase={(v) => setRow(i, { match_case: v })} />
                      </div>
                    )}
                    <Field label="Into">
                      <Select
                        value={r.tag ? "__tag" : r.field_key}
                        onChange={(e) => (e.target.value === "__tag" ? setRow(i, { tag: true, field_key: "" }) : setRow(i, { tag: false, field_key: e.target.value }))}
                      >
                        <option value="">Choose a field…</option>
                        {fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label} ({CUSTOM_FIELD_KIND_LABEL[f.type]})
                          </option>
                        ))}
                        {/* A field deleted since (1.20.30's rule): shown so it can be changed; saving drops it and says so. */}
                        {gone && <option value={r.field_key}>A deleted field</option>}
                        <option value="__tag">Add as a tag</option>
                      </Select>
                    </Field>
                    {!r.tag && (
                      <label className="inline-flex items-center gap-1.5 self-end pb-2 text-sm text-slate-700">
                        <input type="checkbox" checked={r.only_if_empty} onChange={(e) => setRow(i, { only_if_empty: e.target.checked })} />
                        Only if the field is empty
                      </label>
                    )}
                  </div>
                  <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove copy ${i + 1}`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "hover-danger shrink-0")}>
                    <X aria-hidden />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className={rows.length ? "mt-3" : ""}>{full ? <Tooltip label={`A rule copies up to ${AUTOMATION_BODY_LIMITS.copies} values.`}>{add}</Tooltip> : add}</div>
      {tried && error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </fieldset>
  );
}
