// Helpdesk 1.20.8: the queue's custom field conditions, read and turned into
// SQL (the grammar and the rules are in custom-field-filters-shared). The
// queue's filter parser (lib/helpdesk/ticket-filters) reads `cf.<key>`
// parameters through parseCustomFieldFilters, so the desk's list, saved
// views, the export, the API v1 list and hd_queue meet one check; listTickets
// (lib/helpdesk/tickets) adds customFieldFilterSql per condition.
//
// SQL: one correlated EXISTS (or NOT EXISTS) per condition against
// hd_ticket_custom_values, whose primary key (ticket_id, field_id) is the
// index it walks, so no index is added. Every value is a bound parameter;
// a "contains" text is LIKE-escaped. Numbers are compared only on number
// values (a CASE, so a stray value never fails the query), dates by their
// first ten characters (a date and time is compared by its day).
//
// Server-only.

import "server-only";
import { hq } from "./db-core";
import { HD_FORM_FIELD_TYPES } from "./request-types";
import {
  cfFieldKey,
  isCfFilterKey,
  parseCfCondition,
  CF_FILTER_MAX,
  type HdCfCondition,
  type HdCfFilterField,
} from "./custom-field-filters-shared";
import type { HdFormFieldType, HdFormOption } from "./types";

export * from "./custom-field-filters-shared";

/** One checked condition with what its SQL needs. */
export interface HdCfFilter extends HdCfFilterField {
  field_id: number;
  all_teams: boolean;
  team_ids: number[];
  cond: HdCfCondition;
}

type Out = { ok: true; filters: HdCfFilter[] } | { ok: false; error: string };

interface DefRow {
  id: number;
  key: string;
  label: string;
  type: string;
  options: unknown;
  all_teams: number;
  team_ids: number[] | null;
  archived_at: string | null;
}

/**
 * The `cf.<key>` parameters out of a queue query: each names a custom field
 * (archived ones too) and holds one condition that fits its kind. Answers
 * [] when there are none (and reads nothing), or the 400 sentence.
 */
export async function parseCustomFieldFilters(p: URLSearchParams): Promise<Out> {
  const keys: string[] = [];
  for (const k of new Set(p.keys())) if (isCfFilterKey(k)) keys.push(k);
  if (!keys.length) return { ok: true, filters: [] };
  if (keys.length > CF_FILTER_MAX) return { ok: false, error: `Filter by up to ${CF_FILTER_MAX} custom fields at once.` };
  for (const k of keys) {
    if (p.getAll(k).length > 1) return { ok: false, error: `One condition per custom field: "${cfFieldKey(k).slice(0, 60)}" has more than one.` };
  }
  const fieldKeys = keys.map(cfFieldKey);
  const rows = await hq<DefRow>(
    "SELECT id, key, label, type, options, all_teams, team_ids, archived_at FROM hd_custom_fields WHERE key = ANY($1::text[])",
    [fieldKeys]
  );
  const filters: HdCfFilter[] = [];
  for (const k of keys) {
    const key = cfFieldKey(k);
    const r = rows.find((x) => x.key === key);
    if (!r) return { ok: false, error: `There is no custom field with the key "${key.slice(0, 60)}". It may have been deleted.` };
    const type = (HD_FORM_FIELD_TYPES as readonly string[]).includes(r.type) ? (r.type as HdFormFieldType) : "text";
    const options = Array.isArray(r.options) ? (r.options as HdFormOption[]) : [];
    const parsed = parseCfCondition({ label: r.label, type, options }, p.get(k) ?? "");
    if (!parsed.ok) return { ok: false, error: parsed.error };
    filters.push({
      field_id: Number(r.id),
      key: r.key,
      label: r.label,
      type,
      options,
      archived: r.archived_at !== null,
      all_teams: r.all_teams === 1,
      team_ids: (r.team_ids ?? []).map(Number),
      cond: parsed.cond,
    });
  }
  return { ok: true, filters };
}

/** LIKE's own characters escaped (backslash is Postgres's default escape). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/**
 * One condition as a WHERE clause over `hd_tickets t`. `bind` adds a
 * parameter and answers its placeholder. A value condition also requires
 * the ticket to be on a team the field is assigned to; so does "empty".
 */
export function customFieldFilterSql(c: HdCfFilter, bind: (v: unknown) => string): string {
  const fid = bind(c.field_id);
  const row = (pred?: string) => `EXISTS (SELECT 1 FROM hd_ticket_custom_values cv WHERE cv.ticket_id = t.id AND cv.field_id = ${fid}${pred ? ` AND ${pred}` : ""})`;
  const txt = "COALESCE(cv.value #>> '{}', '')";
  const num = "(CASE WHEN jsonb_typeof(cv.value) = 'number' THEN (cv.value)::numeric END)";
  const day = "(CASE WHEN jsonb_typeof(cv.value) = 'string' THEN left(cv.value #>> '{}', 10) END)";
  const { op, values, arg } = c.cond;
  let clause: string;
  switch (op) {
    case "empty":
      clause = `NOT ${row()}`;
      break;
    case "filled":
      clause = row();
      break;
    case "any":
      clause = row(`${txt} = ANY(${bind(values)}::text[])`);
      break;
    case "any_or_empty":
      // No value, or a value on the list (a ticket holds at most one value per field).
      clause = `NOT ${row(`NOT (${txt} = ANY(${bind(values)}::text[]))`)}`;
      break;
    case "yes":
      clause = row("cv.value = 'true'::jsonb");
      break;
    case "no":
      clause = row("cv.value = 'false'::jsonb");
      break;
    case "contains":
      clause = row(`${txt} ILIKE ${bind(`%${likeEscape(arg)}%`)}`);
      break;
    case "eq":
      clause = row(`${num} = ${bind(arg)}::numeric`);
      break;
    case "gte":
      clause = row(`${num} >= ${bind(arg)}::numeric`);
      break;
    case "lte":
      clause = row(`${num} <= ${bind(arg)}::numeric`);
      break;
    case "on":
      clause = row(`${day} = ${bind(arg)}`);
      break;
    case "before":
      clause = row(`${day} < ${bind(arg)}`);
      break;
    case "after":
      clause = row(`${day} > ${bind(arg)}`);
      break;
    case "is":
      clause = row(`${txt} = ${bind(arg)}`);
      break;
  }
  // An "All teams" field applies to every ticket, those with no team too.
  if (c.all_teams) return `(${clause})`;
  return `(t.team_id = ANY(${bind(c.team_ids)}::int[]) AND ${clause})`;
}
