// Helpdesk 1.20.8: filtering the queue by a custom field (1.20.6,
// lib/helpdesk/custom-fields), the parts the desk's client code and the
// server share. Pure: safe in client components.
//
// A condition travels as one queue parameter per field, beside the queue's
// other filters (lib/helpdesk/ticket-filters), so a saved view, a queue
// address, the API v1 list and hd_queue all hold the same thing:
//
//   cf.<key>=<op>            empty | filled | yes | no
//   cf.<key>=<op>:<arg>      any:<option values, comma-separated>
//                            any_or_empty:<option values>   (or not filled in)
//                            contains:<text>                 (case-insensitive)
//                            eq: | gte: | lte:<number>
//                            on: | before: | after:<YYYY-MM-DD>
//                            is:<user id>
//
// Which ops fit which kind (CF_OPS_BY_KIND):
//   Pick one       any, any_or_empty, empty, filled
//   Yes / no       yes, no, empty
//   Short / long   contains, empty, filled
//   Number         eq, gte, lte, empty, filled
//   Date (+ time)  on, before, after, empty, filled; a date and time is
//                  compared by its day (values are wall-clock in the
//                  workspace's zone, as the field stores them)
//   A person       is, empty, filled
// One condition per field; conditions on several fields combine with AND,
// and with the queue's other filters.
//
// Teams: a field only has a value where it applies. A value condition
// matches tickets that hold a matching value AND are on a team the field is
// assigned to (an "All teams" field: every ticket, those with no team too).
// "empty" (Not filled in) counts tickets on those teams only, never tickets
// of teams that don't use the field. Archived fields still filter (a saved
// view that uses one keeps working); the desk offers only live fields for
// new conditions.

import type { HdFormFieldType, HdFormOption } from "./types";

export const CF_FILTER_PREFIX = "cf.";
/** Custom field conditions in one list or view. */
export const CF_FILTER_MAX = 10;
/** Text a "contains" condition may search for. */
export const CF_TEXT_MAX = 200;
/** A whole condition as a parameter value (a pick-one field's 50 options of up to 100 characters fit). */
export const CF_VALUE_MAX = 6000;

export const CF_OPS = ["any", "any_or_empty", "empty", "filled", "yes", "no", "contains", "eq", "gte", "lte", "on", "before", "after", "is"] as const;
export type HdCfOp = (typeof CF_OPS)[number];

/** Ops that carry an argument after the colon. */
const ARG_OPS: ReadonlySet<HdCfOp> = new Set(["any", "any_or_empty", "contains", "eq", "gte", "lte", "on", "before", "after", "is"]);

type KindGroup = "choice" | "checkbox" | "text" | "number" | "date" | "user";

export function cfKindGroup(type: HdFormFieldType): KindGroup {
  if (type === "choice" || type === "select") return "choice";
  if (type === "checkbox") return "checkbox";
  if (type === "number") return "number";
  if (type === "date" || type === "datetime") return "date";
  if (type === "user") return "user";
  return "text";
}

export const CF_OPS_BY_KIND: Record<KindGroup, readonly HdCfOp[]> = {
  choice: ["any", "any_or_empty", "empty", "filled"],
  checkbox: ["yes", "no", "empty"],
  text: ["contains", "empty", "filled"],
  number: ["eq", "gte", "lte", "empty", "filled"],
  date: ["on", "before", "after", "empty", "filled"],
  user: ["is", "empty", "filled"],
};

/**
 * The conditions the Filter dialog offers per kind, in its words. A pick-one
 * field has one ("is any of", its options ticked, "Not filled in" among
 * them), so its row shows no condition menu.
 */
export const CF_OP_CHOICES: Record<KindGroup, { op: HdCfOp; label: string }[]> = {
  choice: [{ op: "any", label: "is any of" }],
  checkbox: [
    { op: "yes", label: "is Yes" },
    { op: "no", label: "is No" },
    { op: "empty", label: "is not filled in" },
  ],
  text: [
    { op: "contains", label: "contains" },
    { op: "empty", label: "is empty" },
    { op: "filled", label: "is not empty" },
  ],
  number: [
    { op: "eq", label: "equals" },
    { op: "gte", label: "is at least" },
    { op: "lte", label: "is at most" },
    { op: "empty", label: "is empty" },
  ],
  date: [
    { op: "on", label: "is on" },
    { op: "before", label: "is before" },
    { op: "after", label: "is after" },
    { op: "empty", label: "is empty" },
  ],
  user: [
    { op: "is", label: "is" },
    { op: "empty", label: "is empty" },
  ],
};

/** A field as the filter needs it (a definition, or the desk's list of them). */
export interface HdCfFilterField {
  key: string;
  label: string;
  type: HdFormFieldType;
  options: HdFormOption[];
  archived: boolean;
}

/** One condition, checked against its field. */
export interface HdCfCondition {
  op: HdCfOp;
  /** any / any_or_empty: option values. */
  values: string[];
  /** contains: the text; eq/gte/lte: the number as written; on/before/after: YYYY-MM-DD; is: the user id. */
  arg: string;
}

export const isCfFilterKey = (k: string): boolean => k.startsWith(CF_FILTER_PREFIX) && k.length > CF_FILTER_PREFIX.length;
export const cfFieldKey = (k: string): string => k.slice(CF_FILTER_PREFIX.length);
export const cfParamKey = (fieldKey: string): string => `${CF_FILTER_PREFIX}${fieldKey}`;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isDay(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/** How many comma-separated pieces every option of a field makes together: the most an "any" list can hold. */
export function cfMaxPieces(options: HdFormOption[]): number {
  return options.reduce((n, o) => n + o.value.split(",").length, 0);
}

/**
 * Option values out of "a,b,c". A value may itself hold a comma, so the
 * pieces are joined back into known values (at each piece the shortest
 * value that still lets the rest be read wins); null when some piece names
 * no option, or when there are more pieces than the field's options make
 * (cfMaxPieces). 1.20.8 security review: one pass from the end, so the work
 * is the pieces times the longest option's pieces, never a search that
 * backtracks ("any:pc,pc,…,nope" used to take seconds).
 */
export function splitOptionValues(raw: string, options: HdFormOption[]): string[] | null {
  const known = new Set(options.map((o) => o.value));
  if (known.has(raw)) return [raw];
  const parts = raw.split(",");
  if (parts.length > cfMaxPieces(options)) return null;
  const longest = options.reduce((m, o) => Math.max(m, o.value.split(",").length), 1);
  const n = parts.length;
  // next[i]: where the value starting at piece i ends, for a reading of pieces i..n-1; -1 when there is none.
  const next = new Array<number>(n + 1).fill(-1);
  next[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    let v = "";
    for (let j = i + 1; j <= Math.min(n, i + longest); j++) {
      v = j === i + 1 ? parts[i] : `${v},${parts[j - 1]}`;
      if (next[j] !== -1 && known.has(v)) {
        next[i] = j;
        break;
      }
    }
  }
  if (next[0] === -1) return null;
  const out: string[] = [];
  for (let i = 0; i < n; i = next[i]) out.push(parts.slice(i, next[i]).join(","));
  return [...new Set(out)];
}

type Parsed = { ok: true; cond: HdCfCondition } | { ok: false; error: string };

/** A condition string checked against its field: the op fits the kind, the argument fits the op. The error is a sentence. */
export function parseCfCondition(field: Pick<HdCfFilterField, "label" | "type" | "options">, raw: string): Parsed {
  const name = `"${field.label}"`;
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: `Give a condition for ${name}, like empty or contains:text.` };
  if (raw.length > CF_VALUE_MAX) return { ok: false, error: `The condition for ${name} is too long.` };
  const i = raw.indexOf(":");
  const opRaw = (i < 0 ? raw : raw.slice(0, i)).trim();
  const arg = i < 0 ? "" : raw.slice(i + 1);
  const group = cfKindGroup(field.type);
  const allowed = CF_OPS_BY_KIND[group];
  if (!(allowed as readonly string[]).includes(opRaw)) {
    return { ok: false, error: `${name} can't be filtered with "${opRaw.slice(0, 20)}". Use ${allowed.join(", ")}.` };
  }
  const op = opRaw as HdCfOp;
  if (!ARG_OPS.has(op)) {
    if (i >= 0 && arg.trim()) return { ok: false, error: `"${op}" takes nothing after it.` };
    return { ok: true, cond: { op, values: [], arg: "" } };
  }
  switch (op) {
    case "any":
    case "any_or_empty": {
      if (arg.split(",").length > cfMaxPieces(field.options)) {
        const n = field.options.length;
        return { ok: false, error: `${name} has ${n === 1 ? "1 option" : `${n} options`}, so list each at most once.` };
      }
      const values = arg ? splitOptionValues(arg, field.options) : null;
      if (!values || !values.length) {
        const names = field.options.slice(0, 20).map((o) => o.value);
        return { ok: false, error: `${name} is filtered by its option values, comma-separated: ${names.join(", ")}${field.options.length > 20 ? " and more" : ""}.` };
      }
      return { ok: true, cond: { op, values, arg: "" } };
    }
    case "contains": {
      const text = arg.trim();
      if (!text) return { ok: false, error: `Give the text ${name} should contain.` };
      if (text.length > CF_TEXT_MAX) return { ok: false, error: `Search ${name} for up to ${CF_TEXT_MAX} characters.` };
      return { ok: true, cond: { op, values: [], arg: text } };
    }
    case "eq":
    case "gte":
    case "lte": {
      const t = arg.trim();
      const n = Number(t);
      if (!t || !/^-?\d+(\.\d+)?$/.test(t) || !Number.isFinite(n) || Math.abs(n) > 1e12) return { ok: false, error: `${name} is compared with a number, like ${op}:10.` };
      return { ok: true, cond: { op, values: [], arg: t } };
    }
    case "on":
    case "before":
    case "after": {
      const t = arg.trim();
      if (!isDay(t)) return { ok: false, error: `${name} is compared with a date as YYYY-MM-DD, like ${op}:2026-11-20.` };
      return { ok: true, cond: { op, values: [], arg: t } };
    }
    case "is": {
      const t = arg.trim();
      if (!/^\d{1,9}$/.test(t) || Number(t) <= 0) return { ok: false, error: `${name} is matched by a person's user id, like is:42.` };
      return { ok: true, cond: { op, values: [], arg: String(Number(t)) } };
    }
  }
  return { ok: false, error: `${name} can't be filtered that way.` };
}

/** A condition back as its parameter value. */
export function formatCfCondition(c: HdCfCondition): string {
  if (c.op === "any" || c.op === "any_or_empty") return `${c.op}:${c.values.join(",")}`;
  return ARG_OPS.has(c.op) ? `${c.op}:${c.arg}` : c.op;
}

/**
 * The condition in words for the filter strip and the Save dialog:
 * "Device type: Laptop, Phone", "Billable: Yes", 'Serial: contains "AB"',
 * "Cost: at least 50", "Due: before 2026-11-20", "Approver: Ana Lee",
 * "Room: not filled in". `names`: people's names for "A person".
 */
export function cfConditionText(field: Pick<HdCfFilterField, "label" | "type" | "options">, c: HdCfCondition, names?: Map<number, string>): string {
  const opt = (v: string) => field.options.find((o) => o.value === v)?.label ?? v;
  let what: string;
  switch (c.op) {
    case "any":
      what = c.values.map(opt).join(", ");
      break;
    case "any_or_empty":
      what = `${c.values.map(opt).join(", ")} or not filled in`;
      break;
    case "empty":
      what = "not filled in";
      break;
    case "filled":
      what = "filled in";
      break;
    case "yes":
      what = "Yes";
      break;
    case "no":
      what = "No";
      break;
    case "contains":
      what = `contains "${c.arg}"`;
      break;
    case "eq":
      what = c.arg;
      break;
    case "gte":
      what = `at least ${c.arg}`;
      break;
    case "lte":
      what = `at most ${c.arg}`;
      break;
    case "on":
      what = `on ${c.arg}`;
      break;
    case "before":
      what = `before ${c.arg}`;
      break;
    case "after":
      what = `after ${c.arg}`;
      break;
    case "is":
      what = names?.get(Number(c.arg)) ?? "one person";
      break;
  }
  return `${field.label}: ${what}`;
}

/**
 * Every custom field condition in a set of queue filters, in words, in the
 * order the filters hold them. A key no field has any more reads
 * "{key}: deleted field" (once `fields` has loaded); a condition that no longer fits its field reads
 * "{label}: condition no longer fits".
 */
export function cfSummaryParts(f: Record<string, string>, fields: HdCfFilterField[] | undefined, names?: Map<number, string>): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (!isCfFilterKey(k)) continue;
    const key = cfFieldKey(k);
    const field = fields?.find((x) => x.key === key);
    if (!field) {
      // Before the desk's list of fields has loaded, the key and the condition as written.
      parts.push(fields ? `${key.replace(/_/g, " ")}: deleted field` : `${key.replace(/_/g, " ")}: ${v}`);
      continue;
    }
    const p = parseCfCondition(field, v);
    parts.push(p.ok ? cfConditionText(field, p.cond, names) : `${field.label}: condition no longer fits`);
  }
  return parts;
}
