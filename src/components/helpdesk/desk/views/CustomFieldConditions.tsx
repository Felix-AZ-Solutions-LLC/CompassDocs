"use client";

// The Filter dialog's custom field conditions (1.20.8,
// lib/helpdesk/custom-field-filters). A "Custom fields" block under the
// dialog's grid: one row per condition (the field's label, a condition that
// fits its kind and its value), then "Add a custom field", a Select of the
// live fields not used yet. Archived fields are never offered; a view that
// already uses one keeps the row, marked "Archived". A condition on a field
// that was deleted shows as such and must be removed before the list shows.
//
//   Pick one       is any of: its options and "Not filled in" as ticks
//   Yes / no       is Yes | is No | is not filled in
//   Short / long   contains (text) | is empty | is not empty
//   Number         equals | is at least | is at most (a number) | is empty
//   Date (+ time)  is on | is before | is after (a date) | is empty
//   A person       is (the people picker) | is empty

import { useId, useRef } from "react";
import { X } from "lucide-react";
import { iconButtonClass } from "@/components/Button";
import { Select, TextInput } from "@/components/form";
import { FormFieldControl } from "@/components/helpdesk/help/RequestForm";
import {
  cfFieldKey,
  cfKindGroup,
  cfParamKey,
  formatCfCondition,
  isCfFilterKey,
  parseCfCondition,
  CF_FILTER_MAX,
  CF_OP_CHOICES,
  CF_TEXT_MAX,
  type HdCfOp,
} from "@/lib/helpdesk/custom-field-filters-shared";
import type { HdViewFilters } from "@/lib/helpdesk/saved-views-shared";
import type { DeskFilterField } from "../custom-fields/filters";

export interface CfRow {
  /** React's key for the row. */
  id: string;
  key: string;
  op: HdCfOp;
  /** Pick one: the ticked option values. */
  values: string[];
  /** Pick one: "Not filled in" is ticked. */
  empty: boolean;
  /** The text, number, date or user id. */
  arg: string;
  /** A condition the dialog can't edit (a deleted field, or an API-only one like "filled" on a pick-one): kept as written. */
  fixed?: { raw: string; why: "deleted" | "other" };
}

let seq = 0;
const rowId = () => `cf-${++seq}`;

/** The rows for the `cf.*` filters a list or view holds. */
export function rowsFrom(filters: HdViewFilters, fields: DeskFilterField[]): CfRow[] {
  const rows: CfRow[] = [];
  for (const [k, raw] of Object.entries(filters)) {
    if (!isCfFilterKey(k)) continue;
    const key = cfFieldKey(k);
    const field = fields.find((f) => f.key === key);
    if (!field) {
      rows.push({ id: rowId(), key, op: "empty", values: [], empty: false, arg: "", fixed: { raw, why: "deleted" } });
      continue;
    }
    const p = parseCfCondition(field, raw);
    const group = cfKindGroup(field.type);
    if (!p.ok) {
      rows.push({ id: rowId(), key, op: "empty", values: [], empty: false, arg: "", fixed: { raw, why: "other" } });
      continue;
    }
    const c = p.cond;
    if (group === "choice") {
      if (c.op === "any" || c.op === "any_or_empty" || c.op === "empty") {
        rows.push({ id: rowId(), key, op: "any", values: c.values, empty: c.op !== "any", arg: "" });
      } else rows.push({ id: rowId(), key, op: c.op, values: [], empty: false, arg: "", fixed: { raw, why: "other" } });
      continue;
    }
    if (!CF_OP_CHOICES[group].some((o) => o.op === c.op)) {
      rows.push({ id: rowId(), key, op: c.op, values: [], empty: false, arg: "", fixed: { raw, why: "other" } });
      continue;
    }
    rows.push({ id: rowId(), key, op: c.op, values: [], empty: false, arg: c.arg });
  }
  return rows;
}

/** A new row for a field: its kind's first condition, nothing chosen yet. */
function newRow(field: DeskFilterField): CfRow {
  return { id: rowId(), key: field.key, op: CF_OP_CHOICES[cfKindGroup(field.type)][0].op, values: [], empty: false, arg: "" };
}

/** The row as its queue parameter's value, or the sentence that says what is missing. */
function rowValue(row: CfRow, field: DeskFilterField | undefined): { value: string } | { error: string } {
  if (row.fixed) return row.fixed.why === "deleted" ? { error: "This field was deleted. Remove the condition." } : { value: row.fixed.raw };
  if (!field) return { error: "This field was deleted. Remove the condition." };
  const group = cfKindGroup(field.type);
  if (group === "choice") {
    if (!row.values.length && !row.empty) return { error: "Tick at least one." };
    if (!row.values.length) return { value: "empty" };
    return { value: formatCfCondition({ op: row.empty ? "any_or_empty" : "any", values: row.values, arg: "" }) };
  }
  if (row.op === "empty" || row.op === "filled" || row.op === "yes" || row.op === "no") return { value: row.op };
  const arg = row.arg.trim();
  if (!arg) return { error: group === "user" ? "Choose a person." : group === "date" ? "Choose a date." : group === "number" ? "Enter a number." : "Enter some text." };
  const value = formatCfCondition({ op: row.op, values: [], arg });
  const p = parseCfCondition(field, value);
  if (!p.ok) return { error: group === "number" ? "Enter a number." : group === "date" ? "Choose a date." : p.error };
  return { value };
}

/** The rows as `cf.*` filters, and an error per row id for the rows that are not finished. */
export function rowsToFilters(rows: CfRow[], fields: DeskFilterField[]): { filters: HdViewFilters; errors: Record<string, string> } {
  const filters: HdViewFilters = {};
  const errors: Record<string, string> = {};
  for (const r of rows) {
    const v = rowValue(
      r,
      fields.find((f) => f.key === r.key)
    );
    if ("error" in v) errors[r.id] = v.error;
    else filters[cfParamKey(r.key)] = v.value;
  }
  return { filters, errors };
}

export function CustomFieldConditions({
  fields,
  rows,
  onChange,
  errors,
}: {
  fields: DeskFilterField[];
  rows: CfRow[];
  onChange: (rows: CfRow[]) => void;
  /** Shown once the person has tried to show the list. */
  errors: Record<string, string>;
}) {
  const addId = useId();
  const addRef = useRef<HTMLSelectElement>(null);
  const used = new Set(rows.map((r) => r.key));
  const offered = fields.filter((f) => !f.archived && !used.has(f.key));
  if (!rows.length && !offered.length) return null;
  const set = (id: string, patch: Partial<CfRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => {
    onChange(rows.filter((r) => r.id !== id));
    // Focus goes to the picker, which is there whenever a field is free again.
    requestAnimationFrame(() => addRef.current?.focus());
  };

  return (
    <section className="mt-4" aria-labelledby={`${addId}-h`} data-testid="cf-conditions">
      <p id={`${addId}-h`} className="mb-1 text-xs font-medium text-slate-500">
        Custom fields
      </p>
      {rows.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {rows.map((r) => (
            <ConditionRow key={r.id} row={r} field={fields.find((f) => f.key === r.key)} error={errors[r.id]} onSet={(p) => set(r.id, p)} onRemove={() => remove(r.id)} />
          ))}
        </ul>
      )}
      {offered.length > 0 && rows.length < CF_FILTER_MAX && (
        <div className="mt-2 max-w-xs">
          <label htmlFor={`${addId}-add`} className="sr-only">
            Add a custom field
          </label>
          <Select
            id={`${addId}-add`}
            ref={addRef}
            value=""
            onChange={(e) => {
              const f = offered.find((x) => x.key === e.target.value);
              if (f) onChange([...rows, newRow(f)]);
            }}
          >
            <option value="">Add a custom field…</option>
            {offered.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Every condition must match. A field only matches tickets of the teams it is for, and so does &ldquo;not filled in&rdquo;.
      </p>
    </section>
  );
}

function ConditionRow({
  row,
  field,
  error,
  onSet,
  onRemove,
}: {
  row: CfRow;
  field: DeskFilterField | undefined;
  error?: string;
  onSet: (p: Partial<CfRow>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const label = field?.label ?? row.key.replace(/_/g, " ");
  const errId = `${id}-err`;
  const described = error ? errId : undefined;
  const group = field ? cfKindGroup(field.type) : null;
  const choices = group ? CF_OP_CHOICES[group] : [];
  const showArg = group && group !== "choice" && group !== "checkbox" && row.op !== "empty" && row.op !== "filled";

  return (
    <li className="px-3 py-2.5" data-testid={`cf-row-${row.key}`}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 pt-1 text-sm font-medium text-slate-800">
          {label}
          {field?.archived && <span className="ml-1.5 text-xs font-normal text-slate-500">(archived)</span>}
        </p>
        <button type="button" onClick={onRemove} aria-label={`Remove ${label} from the filter`} data-tt="Remove" className={iconButtonClass("quiet", "sm", "-mr-1")}>
          <X aria-hidden />
        </button>
      </div>
      {row.fixed ? (
        <p className="mt-1 text-xs text-slate-500">
          {row.fixed.why === "deleted" ? "This field was deleted." : <>Condition: <span className="font-mono">{row.fixed.raw}</span> (set outside the desk)</>}
        </p>
      ) : field && group === "choice" ? (
        <fieldset className="mt-1.5" aria-describedby={described}>
          <legend className="sr-only">{label} is any of</legend>
          <p className="mb-1 text-xs text-slate-500" aria-hidden>
            is any of
          </p>
          <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-slate-200 px-3 py-2">
            {field.options.map((o) => (
              <label key={o.value} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={row.values.includes(o.value)}
                  onChange={(e) => onSet({ values: e.target.checked ? [...row.values, o.value] : row.values.filter((v) => v !== o.value) })}
                />
                {o.label}
              </label>
            ))}
            {/* An option the field no longer has, still held by the view. */}
            {row.values
              .filter((v) => !field.options.some((o) => o.value === v))
              .map((v) => (
                <label key={v} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="checkbox" className="h-4 w-4" checked onChange={() => onSet({ values: row.values.filter((x) => x !== v) })} />
                  {v} (removed)
                </label>
              ))}
            <label className="inline-flex items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" className="h-4 w-4" checked={row.empty} onChange={(e) => onSet({ empty: e.target.checked })} />
              Not filled in
            </label>
          </div>
        </fieldset>
      ) : field ? (
        <div className="mt-1.5 flex flex-wrap items-start gap-2">
          <Select
            aria-label={`${label} condition`}
            className="w-auto"
            value={row.op}
            onChange={(e) => onSet({ op: e.target.value as HdCfOp })}
            aria-describedby={showArg ? undefined : described}
          >
            {choices.map((c) => (
              <option key={c.op} value={c.op}>
                {c.label}
              </option>
            ))}
          </Select>
          {showArg && group === "user" ? (
            <div className="min-w-48 flex-1" aria-describedby={described}>
              <PersonPick label={label} value={row.arg} onChange={(v) => onSet({ arg: v })} />
            </div>
          ) : showArg ? (
            <TextInput
              aria-label={group === "date" ? `${label} date` : group === "number" ? `${label} number` : `${label} text`}
              aria-describedby={described}
              hasError={!!error}
              className="w-auto min-w-36 flex-1"
              type={group === "date" ? "date" : group === "number" ? "number" : "text"}
              inputMode={group === "number" ? "decimal" : undefined}
              step={group === "number" ? "any" : undefined}
              maxLength={group === "text" ? CF_TEXT_MAX : undefined}
              value={row.arg}
              onChange={(e) => onSet({ arg: e.target.value })}
            />
          ) : null}
        </div>
      ) : null}
      {field?.archived && !row.fixed && <p className="mt-1 text-xs text-slate-500">This field is archived. The view still uses it.</p>}
      {error && (
        <span id={errId} role="alert" className="mt-1 block text-xs text-red-600">
          {error}
        </span>
      )}
    </li>
  );
}

/** The request form's people picker for one person (its own label hidden: the row names the field). */
function PersonPick({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const refs = useRef(new Map<string, HTMLElement | null>());
  return (
    <div className="[&>div>span:first-child]:sr-only">
      <FormFieldControl
        field={{ key: "person", label: `${label}: person`, type: "user", required: true }}
        value={value ? Number(value) : null}
        onChange={(v) => onChange(typeof v === "number" ? String(v) : "")}
        refs={refs}
        prefilled={false}
      />
    </div>
  );
}
