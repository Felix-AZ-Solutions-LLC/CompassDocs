"use client";

// 1.20.23: desk departments in the content editors (STYLEGUIDE §Helpdesk:
// desk departments). One set of pieces for Macros, Canned responses,
// Checklists, Request types, Automations and the workflow builder:
//   - useDeskDepartmentChoices(feature): what this person may pick and see
//     (GET /api/helpdesk/desk-departments?feature=…, the server's own rules);
//   - DeskDepartmentSelect: the editor's "Desk department" field: the
//     departments they manage, plus "All departments" for a desk Admin; an
//     item in a department they don't manage shows it, read-only;
//   - DeskDepartmentFilter: the list's filter, shown only when they see more
//     than one department's items;
//   - DeskDepartmentChip: a row's department, "All departments" for shared.
// The word is always "desk department" where the requester's directory
// department could be meant (lib/helpdesk/desk-departments-shared).
// Lists of these items are not cached across pages; a Desk departments
// change tells any open picker cache to drop (deskDepartmentsChanged).

import { useEffect, useId, useState } from "react";
import { Building2 } from "lucide-react";
import { Chip } from "@/components/Chip";
import { Field, Select } from "@/components/form";
import {
  ALL_DESK_DEPARTMENTS_LABEL,
  deskDepartmentLabel,
  type HdDeskDepartmentChoices,
  type HdDeskDepartmentFeature,
} from "@/lib/helpdesk/desk-departments-shared";
import { getJson } from "../api";

/** The Select's value for "All departments". */
export const ALL_DEPTS = "all";

/** A department field's value as the API takes it: null for All departments. */
export function deptPayload(value: string): number | null {
  return value === ALL_DEPTS || value === "" ? null : Number(value);
}

/** An item's department as the field's value. */
export function deptValue(id: number | null | undefined): string {
  return id === null || id === undefined ? ALL_DEPTS : String(id);
}

const CHANGED = "compass:desk-departments-changed";

/** Tell open pickers and lists that desk departments, or an item's department, changed. */
export function deskDepartmentsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

/** Run `fn` when desk departments change (a module cache drops its copy). Returns the unsubscribe. */
export function onDeskDepartmentsChanged(fn: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
}

/** What this person may choose for one feature's items; null while loading (or when it can't be read). */
export function useDeskDepartmentChoices(feature: HdDeskDepartmentFeature): HdDeskDepartmentChoices | null {
  const [choices, setChoices] = useState<HdDeskDepartmentChoices | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      getJson<HdDeskDepartmentChoices>(`/api/helpdesk/desk-departments?feature=${feature}`, "Couldn't load the desk departments.")
        .then((c) => live && setChoices(c))
        .catch(() => live && setChoices(null));
    void load();
    const off = onDeskDepartmentsChanged(() => void load());
    return () => {
      live = false;
      off();
    };
  }, [feature]);
  return choices;
}

/**
 * The editor's Desk department field. `value` is deptValue(); new items start at
 * choices.default_id. With one department to choose and no All departments, it
 * still shows (read as "where this lives"), as a one-option select.
 */
export function DeskDepartmentSelect({
  choices,
  value,
  onChange,
  disabled,
  help,
}: {
  choices: HdDeskDepartmentChoices | null;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  help?: string;
}) {
  if (!choices) return null;
  const mine = choices.departments.filter((d) => d.manageable);
  const current = value === ALL_DEPTS ? null : choices.departments.find((d) => String(d.id) === value);
  const readOnly = !!current && !current.manageable;
  return (
    <Field
      label="Desk department"
      help={
        help ??
        (choices.can_all
          ? `Agents of this desk department's teams see and use it. ${ALL_DESK_DEPARTMENTS_LABEL} shares it with every agent.`
          : "Agents of this desk department's teams see and use it.")
      }
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || (value === ALL_DEPTS && !choices.can_all) || readOnly} data-testid="hd-desk-department">
        {mine.map((d) => (
          <option key={d.id} value={String(d.id)}>
            {d.name}
          </option>
        ))}
        {readOnly && current && <option value={String(current.id)}>{current.name}</option>}
        {(choices.can_all || value === ALL_DEPTS) && <option value={ALL_DEPTS}>{ALL_DESK_DEPARTMENTS_LABEL}</option>}
      </Select>
    </Field>
  );
}

/** The list's filter: every department this person sees, and All departments. Hidden when they see one department only. */
export function DeskDepartmentFilter({ choices, value, onChange }: { choices: HdDeskDepartmentChoices | null; value: string; onChange: (v: string) => void }) {
  const id = useId();
  if (!choices?.filter) return null;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-slate-600">
        Desk department
      </label>
      <Select id={id} dense value={value} onChange={(e) => onChange(e.target.value)} className="w-auto" data-testid="hd-desk-department-filter">
        <option value="">Every desk department</option>
        {choices.departments.map((d) => (
          <option key={d.id} value={String(d.id)}>
            {d.name}
          </option>
        ))}
        <option value={ALL_DEPTS}>{ALL_DESK_DEPARTMENTS_LABEL} (shared)</option>
      </Select>
    </div>
  );
}

/** Keep the rows the filter's value names ("" = all of them). Personal items (owner_id) are in no department. */
export function byDeskDepartment<T extends { desk_department_id?: number | null; owner_id?: number | null }>(rows: T[], filter: string): T[] {
  if (!filter) return rows;
  return rows.filter((r) => !r.owner_id && (filter === ALL_DEPTS ? r.desk_department_id == null : String(r.desk_department_id) === filter));
}

/** A row's department chip. Shown only when the person sees more than one department (the filter is offered). */
export function DeskDepartmentChip({ id, choices }: { id: number | null | undefined; choices: HdDeskDepartmentChoices | null }) {
  if (!choices?.filter) return null;
  return (
    <Chip tone={id == null ? "info" : "neutral"} size="sm">
      <Building2 className="h-3 w-3" aria-hidden />
      <span className="sr-only">Desk department: </span>
      {deskDepartmentLabel(id, choices.departments)}
    </Chip>
  );
}
